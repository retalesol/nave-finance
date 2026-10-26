import { PublicKey } from "npm:@solana/web3.js@1.95.0";
import { corsHeadersFor, jsonWithCors, secretsMatch } from "../_shared/http.ts";
import { clientKey, rateLimit } from "../_shared/rateLimit.ts";
import {
  readMoonPayEnv,
  signMoonPayQuery,
  validateMoonPaySignUrl,
  type SolanaPublicKeyCtor,
} from "../_shared/moonpay.ts";

/**
 * POST /moonpay-sign
 *
 * Body: { url: string, daoAddress: string, chainId: number | null }
 * 200:  { signature: string }  — raw base64 HMAC of the query string, not URL-encoded
 * non-200: { error: string }
 *
 * verify_jwt is off, same as the other browser functions. The caller must send
 * the Supabase anon key (or the service role) as Authorization: Bearer, which
 * is the header callEdgeFunction already attaches. The anon key is not proof
 * of a user; the URL checks below are what keep this from signing an arbitrary
 * wallet.
 */

interface SignBody {
  url?: unknown;
  daoAddress?: unknown;
  chainId?: unknown;
}

function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function callerAuthorized(req: Request, anonKey: string | undefined, serviceKey: string | undefined): boolean {
  const token = bearerToken(req);
  const apiKey = (req.headers.get("apikey") ?? "").trim();
  if (anonKey && (secretsMatch(token, anonKey) || secretsMatch(apiKey, anonKey))) return true;
  if (serviceKey && (secretsMatch(token, serviceKey) || secretsMatch(apiKey, serviceKey))) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req, { allowBrowserFallback: true });
  const json = (data: unknown, status = 200) => jsonWithCors(corsHeaders, data, status);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const limited = rateLimit(req, { key: clientKey(req, "moonpay-sign"), limit: 60, windowMs: 60_000 }, corsHeaders);
  if (limited) return limited;

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!anonKey && !serviceKey) {
    return json({ error: "Supabase auth is not configured" }, 500);
  }
  if (!callerAuthorized(req, anonKey, serviceKey)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const env = readMoonPayEnv();
  if (!env.secretKey || !env.publishableKey) {
    return json({ error: "MoonPay is not configured" }, 500);
  }

  let body: SignBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request" }, 400);
  }
  if (typeof body.url !== "string" || body.url.length === 0 || body.url.length > 4096) {
    return json({ error: "url is required" }, 400);
  }
  if (typeof body.daoAddress !== "string" || body.daoAddress.trim().length === 0) {
    return json({ error: "daoAddress is required" }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "chainId")) {
    return json({ error: "chainId is required" }, 400);
  }
  if (body.chainId !== null && (typeof body.chainId !== "number" || !Number.isInteger(body.chainId))) {
    return json({ error: "chainId must be an integer or null" }, 400);
  }

  const decision = validateMoonPaySignUrl(
    { url: body.url, daoAddress: body.daoAddress, chainId: body.chainId },
    {
      publishableKey: env.publishableKey,
      programId: env.programId,
      PublicKey: PublicKey as unknown as SolanaPublicKeyCtor,
    },
  );
  if (!decision.ok) {
    return json({ error: decision.error }, 400);
  }

  try {
    const signature = await signMoonPayQuery(decision.query, env.secretKey);
    return json({ signature });
  } catch (err) {
    console.error("moonpay-sign failed:", err instanceof Error ? err.message : "sign error");
    return json({ error: "Failed to sign MoonPay URL" }, 500);
  }
});
