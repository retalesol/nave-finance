// Shared HTTP helpers for Supabase edge functions.
//
// Centralizes the security posture so every function behaves identically:
//   - CORS origin allow-listing driven by the NAVE_ALLOWED_ORIGINS env var
//     (comma-separated). When unset we fall back to permissive `*` so local
//     development keeps working, but production deployments MUST set it.
//   - Constant-time shared-secret comparison for header-based auth.
//
// Usage inside a function handler:
//
//   Deno.serve((req) => {
//     const corsHeaders = corsHeadersFor(req);
//     const jsonResponse = (data: unknown, status = 200) =>
//       jsonWithCors(corsHeaders, data, status);
//     if (req.method === "OPTIONS") {
//       return new Response(null, { status: 204, headers: corsHeaders });
//     }
//     // ...existing jsonResponse(...) call sites keep working unchanged.
//   });

const ALLOWED_ORIGINS: string[] = (Deno.env.get("NAVE_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const ALLOWED_ORIGIN_SET = new Set(ALLOWED_ORIGINS);

// Explicit, opt-in escape hatch for LOCAL DEVELOPMENT ONLY. Production must set
// NAVE_ALLOWED_ORIGINS; otherwise browser-facing functions fail closed (no
// Access-Control-Allow-Origin is emitted, so browsers block the cross-origin read).
const DEV_ALLOW_ALL_ORIGINS =
  (Deno.env.get("NAVE_CORS_DEV_ALLOW_ALL") ?? "").toLowerCase() === "true";

const BASE_CORS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, X-Agent-Secret, X-Indexer-Secret, X-Policy-Secret, X-Proposer-Secret, X-Wallet-Address, X-Break-Glass-Secret, X-Compass-Session",
  Vary: "Origin",
};

interface CorsOptions {
  /**
   * Browser-safe fallback for public browser-callable functions.
   * When no explicit allow-list is configured, reflect the request origin for
   * valid http(s) origins so the client does not fail with opaque CORS fetch
   * errors. Secret/internal functions should keep this disabled.
   */
  allowBrowserFallback?: boolean;
}

function isBrowserOrigin(origin: string | null): origin is string {
  if (!origin || origin === "null") return false;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function originWithWwwAlias(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
      return u.toString().replace(/\/$/, "");
    }

    u.hostname = `www.${u.hostname}`;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGIN_SET.has("*") || ALLOWED_ORIGIN_SET.has(origin)) {
    return true;
  }

  const alias = originWithWwwAlias(origin);
  return Boolean(alias && ALLOWED_ORIGIN_SET.has(alias));
}

/** Resolve per-request CORS headers against the configured allow-list. */
export function corsHeadersFor(req: Request, options?: CorsOptions): Record<string, string> {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = { ...BASE_CORS };

  if (ALLOWED_ORIGINS.length === 0) {
    // No allow-list configured. Fail closed in production (emit no
    // Access-Control-Allow-Origin) unless the explicit dev escape hatch is set.
    if (DEV_ALLOW_ALL_ORIGINS) {
      headers["Access-Control-Allow-Origin"] = origin ?? "*";
    } else if (options?.allowBrowserFallback && isBrowserOrigin(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
  }

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  // Disallowed origins receive no Access-Control-Allow-Origin header, so the
  // browser blocks the cross-origin read.
  return headers;
}

/** Build a JSON Response with the supplied (already-resolved) CORS headers. */
export function jsonWithCors(
  corsHeaders: Record<string, string>,
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Length-checked, constant-time secret comparison to avoid timing oracles. */
export function secretsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Enforce a required shared secret on a request header.
 * Returns null when authorized, or a ready-to-return 401/500 Response.
 */
export function requireSecret(
  req: Request,
  envVar: string,
  headerName: string,
  corsHeaders: Record<string, string>,
): Response | null {
  const expected = Deno.env.get(envVar);
  if (!expected) {
    return jsonWithCors(corsHeaders, { error: `Service not configured: ${envVar}` }, 500);
  }
  if (!secretsMatch(req.headers.get(headerName), expected)) {
    return jsonWithCors(corsHeaders, { error: "Unauthorized" }, 401);
  }
  return null;
}
