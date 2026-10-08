#!/usr/bin/env node
/** DEVNET: founder enables (or pauses) the autonomous agent pipeline via the
 *  deployed agent-admin edge fn, which has the signer co-sign nave_core
 *  toggle_agents with the Executive agent key.
 *  Challenge: nave-admin|<dao>|toggle_agents|<0|1>|<unix_ms>  (ed25519 base64). */
import { readFileSync } from "node:fs";
import { sign as edSign, createPrivateKey } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const FN_BASE = arg("--base", process.env.SUPABASE_FUNCTIONS_URL || "");
const ANON = process.env.SUPABASE_ANON_KEY || "";
const dao = arg("--dao", null);
const enabled = arg("--enabled", "true") === "true";
const walletPath = arg("--wallet", new URL("../.deploy-wallet-devnet.json", import.meta.url).pathname);
if (!dao) { console.error("missing --dao"); process.exit(1); }

const founder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const wallet = founder.publicKey.toBase58();
const flag = enabled ? "1" : "0";
const message = `nave-admin|${dao}|toggle_agents|${flag}|${Date.now()}`;
const seed = Buffer.from(founder.secretKey.slice(0, 32));
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const keyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const signature = edSign(null, Buffer.from(message), keyObject).toString("base64");

console.log("POST agent-admin", { dao, enabled, wallet, message });
const res = await fetch(`${FN_BASE}/agent-admin`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(ANON ? { Authorization: `Bearer ${ANON}`, apikey: ANON } : {}) },
  body: JSON.stringify({ dao_address: dao, wallet, message, signature, enabled }),
});
console.log("HTTP", res.status);
console.log(await res.text());
