#!/usr/bin/env node
/**
 * DEVNET autonomous trigger: founder signs the orchestrator-proxy challenge and
 * POSTs it, exercising the DEPLOYED edge stack (orchestrator-proxy ->
 * agent-orchestrator -> Railway signer) to advance an execution request through
 * the 3-of-3 agent approvals to execution with NO human signer.
 *
 * Challenge: nave-dispatch|<dao>|<er_or_poll>|<unix_ms>  (ed25519, base64 sig).
 */
import { readFileSync } from "node:fs";
import { sign as edSign, createPrivateKey } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const FN_BASE = arg("--base", process.env.SUPABASE_FUNCTIONS_URL || "");
const ANON = process.env.SUPABASE_ANON_KEY || "";
const dao = arg("--dao", null);
const er = arg("--er", null); // optional; omit for poll mode
const walletPath = arg("--wallet", new URL("../.deploy-wallet-devnet.json", import.meta.url).pathname);

if (!dao) { console.error("missing --dao"); process.exit(1); }

const founder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const wallet = founder.publicKey.toBase58();
const target = er ?? "poll";
const message = `nave-dispatch|${dao}|${target}|${Date.now()}`;

// ed25519 detached sign over UTF-8 message using the 32-byte seed.
const seed = Buffer.from(founder.secretKey.slice(0, 32));
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const keyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const sig = edSign(null, Buffer.from(message), keyObject);
const signature = sig.toString("base64");

const body = er
  ? { dao_address: dao, execution_request_address: er, wallet, message, signature }
  : { dao_address: dao, wallet, message, signature };

console.log("POST orchestrator-proxy", { dao, target, wallet, message });
const res = await fetch(`${FN_BASE}/orchestrator-proxy`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(ANON ? { Authorization: `Bearer ${ANON}`, apikey: ANON } : {}) },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log("HTTP", res.status);
console.log(text);
