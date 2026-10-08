#!/usr/bin/env node
/**
 * Emit a markdown beta-health report for core public endpoints.
 *
 * Required env:
 *   SUPABASE_URL
 * Optional env:
 *   NAVE_SIGNER_URL  (defaults to production Railway URL)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const NAVE_SIGNER_URL =
  process.env.NAVE_SIGNER_URL || "https://nave-server-production.up.railway.app";

if (!SUPABASE_URL) {
  console.error("Missing env: SUPABASE_URL (or VITE_SUPABASE_URL)");
  process.exit(1);
}

const checks = [
  {
    id: "edge-index-events",
    label: "Supabase edge index-events",
    url: `${SUPABASE_URL}/functions/v1/index-events`,
  },
  {
    id: "edge-snapshot-treasury",
    label: "Supabase edge snapshot-treasury",
    url: `${SUPABASE_URL}/functions/v1/snapshot-treasury`,
  },
  {
    id: "edge-helius-webhook",
    label: "Supabase edge helius-webhook",
    url: `${SUPABASE_URL}/functions/v1/helius-webhook`,
  },
  {
    id: "signer-health",
    label: "Railway signer /health",
    url: `${NAVE_SIGNER_URL.replace(/\/+$/, "")}/health`,
  },
];

function icon(ok) {
  return ok ? "✅" : "❌";
}

async function runCheck(check) {
  const started = Date.now();
  try {
    const response = await fetch(check.url, { method: "GET" });
    const body = await response.text();
    const ms = Date.now() - started;

    return {
      ...check,
      ok: response.ok || response.status === 401 || response.status === 405,
      status: response.status,
      ms,
      preview: body.slice(0, 180).replace(/\s+/g, " ").trim(),
    };
  } catch (error) {
    return {
      ...check,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      preview: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = await Promise.all(checks.map(runCheck));
const okCount = results.filter((r) => r.ok).length;
const timestamp = new Date().toISOString();

const lines = [];
lines.push("# Nave Beta Health Report");
lines.push("");
lines.push(`- Generated: ${timestamp}`);
lines.push(`- Passed: ${okCount}/${results.length}`);
lines.push("");
lines.push("## Endpoint checks");
lines.push("");
for (const result of results) {
  lines.push(
    `- ${icon(result.ok)} ${result.label} \`status=${result.status}\` \`latency=${result.ms}ms\``
  );
  if (result.preview) {
    lines.push(`  - Response preview: ${result.preview}`);
  }
}
lines.push("");
lines.push("## Verdict");
lines.push("");
if (okCount === results.length) {
  lines.push("- ✅ No hard blockers detected from public endpoint probes.");
} else {
  lines.push("- ❌ One or more endpoint probes failed; inspect entries above.");
}

console.log(lines.join("\n"));
process.exit(okCount === results.length ? 0 : 2);
