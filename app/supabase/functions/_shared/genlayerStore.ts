// Reads and writes genlayer_reviews.
//
// One row shape for every chain family, keyed by
// (chain_family, network, treasury, action_hash, kind). Solana and EVM
// screens read the same columns. A missing table or a failed read returns an
// empty view so a gate that is off does not throw; a gate that is on then
// fails closed on the missing charter.

import {
  type ChainFamily,
  type GenlayerView,
  type GenNetwork,
  type PublicCharterInput,
  type ReviewKind,
  type ReviewRow,
  charterRpcParams,
  isActionHash,
  normalizeActionHash,
  treasuryKey,
  viewFromRows,
} from "./genlayerCharter.ts";

function envGet(name: string): string {
  try {
    const g = globalThis as { Deno?: { env: { get(key: string): string | undefined } } };
    return g.Deno?.env.get(name) ?? "";
  } catch {
    return "";
  }
}

export async function fetchGenlayerView(args: {
  treasury: string;
  chainFamily: ChainFamily;
  network?: GenNetwork;
  actionHash: string;
  protocolId?: string | null;
}): Promise<GenlayerView> {
  const empty: GenlayerView = { chain_family: args.chainFamily, charter: null, venue: null, halt: null };
  const url = envGet("SUPABASE_URL");
  const key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !args.treasury) return empty;
  const treasury = treasuryKey(args.chainFamily, args.treasury);
  const params = new URLSearchParams({
    select: "kind,decision,finished,provisional,rule_ids,summary,venue_status,action_hash,tx_id",
    treasury: `eq.${treasury}`,
    chain_family: `eq.${args.chainFamily}`,
    order: "updated_at.desc",
    limit: "40",
  });
  if (args.network) params.set("network", `eq.${args.network}`);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/genlayer_reviews?${params}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return empty;
    const rows = await res.json();
    if (!Array.isArray(rows)) return empty;
    return viewFromRows(rows as ReviewRow[], {
      chainFamily: args.chainFamily,
      actionHash: args.actionHash,
      protocolId: args.protocolId,
    });
  } catch {
    return empty;
  }
}

function storedActionHash(input: PublicCharterInput): string {
  return isActionHash(input.action_hash) ? normalizeActionHash(input.action_hash) : input.action_hash.trim();
}

/** The transaction id already stored for this case, or "" when there is none. */
export async function fetchStoredTx(input: PublicCharterInput, kind: ReviewKind): Promise<string> {
  const url = envGet("SUPABASE_URL");
  const key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "";
  const params = new URLSearchParams({
    select: "tx_id",
    chain_family: `eq.${input.chain_family}`,
    network: `eq.${input.network}`,
    treasury: `eq.${treasuryKey(input.chain_family, input.treasury)}`,
    action_hash: `eq.${storedActionHash(input)}`,
    kind: `eq.${kind}`,
    limit: "1",
  });
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/genlayer_reviews?${params}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return "";
    const rows = await res.json();
    const tx = Array.isArray(rows) ? rows[0]?.tx_id : "";
    return typeof tx === "string" ? tx : "";
  } catch {
    return "";
  }
}

export async function saveGenlayerReview(
  input: PublicCharterInput,
  kind: ReviewKind,
  fields: {
    decision: string;
    customer_status: string;
    finished: boolean;
    provisional: boolean;
    rule_ids: string[];
    summary: string;
    venue_status: string | null;
    tx_id: string;
  },
): Promise<void> {
  const url = envGet("SUPABASE_URL");
  const key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !fields.tx_id) return;
  const row = {
    chain_family: input.chain_family,
    network: input.network,
    treasury: treasuryKey(input.chain_family, input.treasury),
    action_hash: storedActionHash(input),
    kind,
    decision: fields.decision,
    customer_status: fields.customer_status,
    finished: fields.finished,
    provisional: fields.provisional,
    rule_ids: fields.rule_ids,
    summary: fields.summary,
    venue_status: fields.venue_status,
    tx_id: fields.tx_id,
    case_id: charterRpcParams(input).case_id,
    appeal_requested: false,
    public_inputs: charterRpcParams(input),
    updated_at: new Date().toISOString(),
  };
  await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/genlayer_reviews?on_conflict=chain_family,network,treasury,action_hash,kind`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    },
  );
}

/** Venue rows for the policy loop. Errors become an empty list. */
export async function fetchVenueWatches(
  supabase: unknown,
  treasury: string,
  chainFamily: string,
): Promise<Array<{ protocolId: string; status: string }>> {
  const client = supabase as {
    from(table: string): {
      select(columns: string): {
        eq(column: string, value: string): {
          eq(column: string, value: string): {
            eq(column: string, value: string): {
              limit(n: number): PromiseLike<{ data: ReviewRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
  try {
    const family = chainFamily as ChainFamily;
    const { data, error } = await client
      .from("genlayer_reviews")
      .select("action_hash, venue_status")
      .eq("treasury", treasuryKey(family, treasury))
      .eq("chain_family", chainFamily)
      .eq("kind", "venue")
      .limit(40);
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((row) => row.venue_status === "fine" || row.venue_status === "watch" || row.venue_status === "stop")
      .map((row) => ({ protocolId: row.action_hash ?? "", status: String(row.venue_status ?? "") }));
  } catch {
    return [];
  }
}
