// Compass operator API. The browser authenticates with the captain password.
// COMPASS_ADMIN_PASSWORD lives only in the edge secret store. This function
// uses the service role to read operational aggregates and to grant Nave Pay.
// It does not return payroll, bank, customer, invoice, journal, or key material.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeadersFor, jsonWithCors } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import {
  credentialsMatch,
  openSession,
  sha256,
  signSession,
} from "../_shared/compassAuth.ts";

const text = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function operatorPassword(): string | null {
  const value = Deno.env.get("COMPASS_ADMIN_PASSWORD") ?? "";
  if (value.length < 12 || value.length > 200) return null;
  return value;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function rpcCode(error: { message?: string; details?: string; hint?: string }): string {
  const blob = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
  if (blob.includes("invalid_reason")) return "invalid_reason";
  if (blob.includes("invalid_term")) return "invalid_term";
  if (blob.includes("unknown_treasury")) return "unknown_treasury";
  if (blob.includes("grant_rate_limited")) return "grant_rate_limited";
  if (blob.includes("not_authorized")) return "unauthorized";
  return "compass_failed";
}

function statusFor(code: string): number {
  if (code === "invalid_reason" || code === "invalid_term") return 400;
  if (code === "unknown_treasury") return 404;
  if (code === "grant_rate_limited") return 429;
  if (code === "unauthorized") return 401;
  return 500;
}

async function attemptBucket(req: Request, secret: string): Promise<string> {
  const digest = await sha256(text.encode(`${secret}:${clientIp(req)}`));
  return hex(digest).slice(0, 32);
}

async function failureCount(
  supabase: SupabaseClient,
  bucket: string,
): Promise<{ count: number } | { error: string }> {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("compass_login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("bucket", bucket)
    .eq("succeeded", false)
    .gte("created_at", since);
  if (error) return { error: error.code ?? "query" };
  return { count: count ?? 0 };
}

async function recordAttempt(
  supabase: SupabaseClient,
  bucket: string,
  succeeded: boolean,
): Promise<boolean> {
  const { error } = await supabase.from("compass_login_attempts").insert({ bucket, succeeded });
  if (error) console.error("[compass] attempt insert", error.code);
  return !error;
}

async function refreshSolPrice(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase
    .from("price_cache")
    .select("updated_at")
    .eq("symbol", "solana")
    .maybeSingle();
  const updated = data?.updated_at ? Date.parse(data.updated_at) : 0;
  if (Number.isFinite(updated) && Date.now() - updated < 10 * 60 * 1000) return;
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const json = await response.json();
    const price = Number(json?.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) return;
    await supabase.from("price_cache").upsert(
      { symbol: "solana", price_usd: price, updated_at: new Date().toISOString() },
      { onConflict: "symbol" },
    );
  } catch (error) {
    console.error("[compass] sol price", error instanceof Error ? error.message : "fetch failed");
  }
}

async function requireSession(
  req: Request,
  supabase: SupabaseClient,
  secret: string,
): Promise<{ sid: string } | null> {
  const opened = await openSession(secret, req.headers.get("x-compass-session") ?? "", Date.now());
  if (!opened) return null;
  const { data, error } = await supabase
    .from("compass_sessions")
    .select("expires_at, revoked_at")
    .eq("id", opened.sid)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  if (Date.parse(data.expires_at) <= Date.now()) return null;
  return opened;
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const json = (data: unknown, status = 200) =>
    jsonWithCors(
      { ...corsHeaders, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
      data,
      status,
    );

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const limited = rateLimit(req, { key: clientKey(req, "compass"), limit: 60, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[compass] service env missing");
    return json({ error: "compass_not_configured" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 8_000) return json({ error: "invalid_body" }, 400);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "invalid_body" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "login") {
    const loginLimited = rateLimit(
      req,
      { key: clientKey(req, "compass-login"), limit: 12, windowMs: 60_000 },
      corsHeaders,
    );
    if (loginLimited) return loginLimited;

    const expected = operatorPassword();
    if (!expected) return json({ error: "compass_not_configured" }, 503);

    const bucket = await attemptBucket(req, serviceKey);
    const failures = await failureCount(supabase, bucket);
    if ("error" in failures) return json({ error: "compass_not_configured" }, 503);
    if (failures.count >= 8) return json({ error: "too_many_requests" }, 429);

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const bounded = username.length <= 64 && password.length <= 200;
    const accepted = bounded && await credentialsMatch(username, password, expected);
    const recorded = await recordAttempt(supabase, bucket, accepted);
    if (!recorded) return json({ error: "compass_not_configured" }, 503);
    if (!accepted) return json({ error: "invalid_credentials" }, 401);

    const sessionId = crypto.randomUUID();
    const signed = await signSession(serviceKey, sessionId, Date.now());
    const { error: sessionError } = await supabase.from("compass_sessions").insert({
      id: sessionId,
      expires_at: new Date(signed.expiresAtMs).toISOString(),
    });
    if (sessionError) {
      console.error("[compass] session insert", sessionError.code);
      return json({ error: "compass_not_configured" }, 503);
    }

    await supabase.from("compass_audit").insert({
      actor: "captain",
      action: "sign_in",
      detail: {},
    });
    await supabase.from("compass_sessions").delete().lt("expires_at", new Date().toISOString());
    await supabase
      .from("compass_login_attempts")
      .delete()
      .lt("created_at", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());

    return json({
      ok: true,
      token: signed.token,
      expires_at: new Date(signed.expiresAtMs).toISOString(),
      username: "captain",
    });
  }

  const session = await requireSession(req, supabase, serviceKey);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (action === "logout") {
    await supabase
      .from("compass_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", session.sid)
      .is("revoked_at", null);
    return json({ ok: true });
  }

  if (action === "overview" || action === "treasuries" || action === "treasury") {
    await refreshSolPrice(supabase);
  }

  if (action === "overview") {
    const { data, error } = await supabase.rpc("compass_overview");
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] overview", error.message);
      return json({ error: code }, statusFor(code));
    }
    return json(data);
  }

  if (action === "treasuries") {
    const query = typeof body.query === "string" ? body.query.slice(0, 80) : "";
    const { data, error } = await supabase.rpc("compass_treasuries", {
      p_query: query,
      p_limit: clampLimit(body.limit, 50, 100),
    });
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] treasuries", error.message);
      return json({ error: code }, statusFor(code));
    }
    return json({ treasuries: data ?? [] });
  }

  if (action === "treasury") {
    const groupId = typeof body.treasuryGroupId === "string" ? body.treasuryGroupId : "";
    if (!UUID.test(groupId)) return json({ error: "unknown_treasury" }, 404);
    const { data, error } = await supabase.rpc("compass_treasury", { p_group: groupId });
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] treasury", error.message);
      return json({ error: code }, statusFor(code));
    }
    if (!data) return json({ error: "unknown_treasury" }, 404);
    return json(data);
  }

  if (action === "happenings") {
    const { data, error } = await supabase.rpc("compass_happenings", {
      p_limit: clampLimit(body.limit, 40, 80),
    });
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] happenings", error.message);
      return json({ error: code }, statusFor(code));
    }
    return json({ happenings: data ?? [] });
  }

  if (action === "audit") {
    const { data, error } = await supabase.rpc("compass_audit_feed", {
      p_limit: clampLimit(body.limit, 40, 80),
    });
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] audit", error.message);
      return json({ error: code }, statusFor(code));
    }
    return json({ audit: data ?? [] });
  }

  if (action === "grant_subscription") {
    const groupId = typeof body.treasuryGroupId === "string" ? body.treasuryGroupId : "";
    const term = typeof body.termMonths === "number" ? body.termMonths : Number(body.termMonths);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!UUID.test(groupId)) return json({ error: "unknown_treasury" }, 404);
    if (term !== 1 && term !== 3 && term !== 12) return json({ error: "invalid_term" }, 400);
    if (reason.length < 1 || reason.length > 500) return json({ error: "invalid_reason" }, 400);
    const { data, error } = await supabase.rpc("compass_grant_pay_subscription", {
      p_treasury_group_id: groupId,
      p_term: term,
      p_reason: reason,
    });
    if (error) {
      const code = rpcCode(error);
      if (code === "compass_failed") console.error("[compass] grant", error.message);
      return json({ error: code }, statusFor(code));
    }
    return json(data);
  }

  return json({ error: "unknown_action" }, 400);
});
