import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import {
  MercuryError,
  mercuryCents,
  mercuryGet,
  mercurySyncEnd,
  mercurySyncStart,
  normalizeMercuryToken,
  redactMercurySecrets,
} from "../_shared/mercury.ts";

/**
 * Read-only Mercury sync. The browser sends a token once, on connect.
 * This function stores it through pay_mercury_put_token and never puts it
 * on a response. Sync reads it back with the service role and issues GET only.
 */

interface ConnectBody {
  action?: string;
  treasury_group_id?: string;
  token?: string;
}

const TREASURY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function accountPayload(raw: Record<string, unknown>) {
  const number = typeof raw.accountNumber === "string" ? raw.accountNumber : "";
  return {
    id: clip(raw.id, 80),
    name: clip(raw.name, 200),
    nickname: clip(raw.nickname, 200),
    kind: clip(raw.kind, 40),
    status: clip(raw.status, 40),
    type: clip(raw.type, 40),
    last4: number.slice(-4),
    available_cents: mercuryCents(raw.availableBalance),
    current_cents: mercuryCents(raw.currentBalance),
    dashboard_link: clip(raw.dashboardLink, 500),
  };
}

function transactionPayload(raw: Record<string, unknown>, accountId: string) {
  return {
    id: clip(raw.id, 80),
    account_id: accountId,
    amount_cents: mercuryCents(raw.amount),
    status: clip(raw.status, 40),
    kind: clip(raw.kind, 80),
    counterparty: clip(raw.counterpartyName, 200),
    bank_description: clip(raw.bankDescription, 500),
    note: clip(raw.note, 1000),
    external_memo: clip(raw.externalMemo, 500),
    posted_at: typeof raw.postedAt === "string" ? raw.postedAt : null,
    created_at: typeof raw.createdAt === "string" ? raw.createdAt : null,
    dashboard_link: clip(raw.dashboardLink, 500),
  };
}

async function fetchAccounts(token: string, base: string | null) {
  const all: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const payload = await mercuryGet("/accounts", { limit: 1000, order: "asc", start_after: after }, token, { base }) as {
      accounts?: unknown;
    };
    const rows = asRows(payload.accounts);
    all.push(...rows);
    if (rows.length < 1000) break;
    const next = rows[rows.length - 1]?.id;
    if (typeof next !== "string" || next === "") break;
    after = next;
  }
  return all;
}

async function fetchTransactions(token: string, accountId: string, start: string, end: string, base: string | null) {
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < 200; page += 1) {
    const payload = await mercuryGet(
      `/account/${encodeURIComponent(accountId)}/transactions`,
      { limit: 500, offset, start, end, order: "asc" },
      token,
      { base },
    ) as { transactions?: unknown; total?: number };
    const rows = asRows(payload.transactions);
    if (rows.length === 0) break;
    all.push(...rows);
    offset += rows.length;
    if (rows.length < 500) break;
    if (typeof payload.total === "number" && offset >= payload.total) break;
  }
  return all;
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "service_not_configured" }, 500);

  const wallet = req.headers.get("x-wallet-address")?.trim() ?? "";
  if (!wallet) return json({ error: "not_authorized" }, 401);

  let body: ConnectBody;
  try {
    body = await req.json() as ConnectBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const treasury = body.treasury_group_id?.trim() ?? "";
  if (!TREASURY.test(treasury)) return json({ error: "invalid_treasury" }, 400);
  const action = body.action;
  if (action !== "connect" && action !== "sync") return json({ error: "unknown_action" }, 400);

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-wallet-address": wallet } },
  });
  const base = Deno.env.get("NAVE_MERCURY_API_BASE")?.trim() || null;

  try {
    if (action === "connect") {
      const token = normalizeMercuryToken(body.token ?? "");
      const accounts = await fetchAccounts(token, base);
      const { error: putError } = await db.rpc("pay_mercury_put_token", {
        p_treasury: treasury,
        p_wallet: wallet,
        p_token: token,
      });
      if (putError) return json({ error: redactMercurySecrets(putError.message) }, 400);
      const { error: upsertError } = await db.rpc("pay_mercury_upsert", {
        p_treasury: treasury,
        p_wallet: wallet,
        p_accounts: accounts.map(accountPayload),
        p_transactions: [],
      });
      if (upsertError) return json({ error: redactMercurySecrets(upsertError.message) }, 400);
      return json({ ok: true, accounts: accounts.length });
    }

    const { data: secret, error: readError } = await db.rpc("pay_mercury_read_token", {
      p_treasury: treasury,
      p_wallet: wallet,
    });
    if (readError) return json({ error: redactMercurySecrets(readError.message) }, 400);
    if (typeof secret !== "string" || secret === "") {
      return json({ error: "Mercury is not connected." }, 409);
    }

    const { data: settings } = await db
      .from("pay_mercury_settings")
      .select("sync_start, last_sync_at")
      .eq("treasury_group_id", treasury)
      .maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    const start = mercurySyncStart(today, settings?.sync_start ?? null, settings?.last_sync_at ?? null);
    const end = mercurySyncEnd(today);
    const accounts = await fetchAccounts(secret, base);
    const transactions: ReturnType<typeof transactionPayload>[] = [];
    for (const account of accounts) {
      if (String(account.status ?? "active") !== "active") continue;
      const accountId = clip(account.id, 80);
      if (!accountId) continue;
      const rows = await fetchTransactions(secret, accountId, start, end, base);
      for (const row of rows) {
        if (!clip(row.id, 80)) continue;
        transactions.push(transactionPayload(row, accountId));
      }
    }

    let created = 0;
    let updated = 0;
    const chunks: ReturnType<typeof transactionPayload>[][] = [];
    for (let index = 0; index < transactions.length; index += 400) {
      chunks.push(transactions.slice(index, index + 400));
    }
    if (chunks.length === 0) chunks.push([]);
    for (let index = 0; index < chunks.length; index += 1) {
      const { data, error } = await db.rpc("pay_mercury_upsert", {
        p_treasury: treasury,
        p_wallet: wallet,
        p_accounts: index === 0 ? accounts.map(accountPayload) : [],
        p_transactions: chunks[index],
      });
      if (error) {
        await db.rpc("pay_mercury_note_sync", {
          p_treasury: treasury,
          p_wallet: wallet,
          p_error: redactMercurySecrets(error.message),
        });
        return json({ error: redactMercurySecrets(error.message) }, 400);
      }
      const result = data as { new?: number; updated?: number } | null;
      created += result?.new ?? 0;
      updated += result?.updated ?? 0;
    }
    await db.rpc("pay_mercury_note_sync", { p_treasury: treasury, p_wallet: wallet, p_error: "" });
    return json({
      ok: true,
      result: { accounts: accounts.length, new: created, updated, window: [start, today] },
    });
  } catch (err) {
    const message = redactMercurySecrets(err instanceof Error ? err.message : "Mercury sync failed");
    const status = err instanceof MercuryError ? err.status : 502;
    if (action === "sync") {
      await db.rpc("pay_mercury_note_sync", { p_treasury: treasury, p_wallet: wallet, p_error: message });
    }
    return json({ error: message }, status >= 400 && status < 600 ? status : 502);
  }
});
