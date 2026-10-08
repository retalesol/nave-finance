#!/usr/bin/env node
/**
 * DEVNET-ONLY admin helper: update global_config.formation_fee_lamports (and
 * paused flag) via update_global_config. Requires the deploy wallet to be the
 * global_config.authority. Used to make devnet DAO creation cheap (0.01 SOL).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const IDL_DIR = existsSync(join(ROOT, "idl")) ? join(ROOT, "idl") : join(ROOT, "target", "idl");
const DEFAULT_RPC = "https://api.devnet.solana.com";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const walletPath = arg("--wallet", join(ROOT, ".deploy-wallet-devnet.json"));
const rpc = arg("--rpc", DEFAULT_RPC);
const feeLamports = BigInt(arg("--fee", "10000000")); // 0.01 SOL default
const paused = arg("--paused", "false") === "true";

const founder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(founder), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(join(IDL_DIR, "nave_core.json"), "utf8"));
const core = new Program(idl, provider);
const corePid = core.programId;
const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], corePid);

const before = await core.account.naveGlobalConfig.fetch(globalConfig);
console.log("before:", {
  authority: before.authority.toBase58(),
  paused: before.paused,
  formation_fee_lamports: before.formationFeeLamports.toString(),
  dao_count: before.daoCount.toString(),
});

const sig = await core.methods
  .updateGlobalConfig(paused, new BN(feeLamports.toString()))
  .accountsPartial({ authority: founder.publicKey, globalConfig })
  .rpc();
console.log("tx:", sig);

const after = await core.account.naveGlobalConfig.fetch(globalConfig);
console.log("after:", {
  paused: after.paused,
  formation_fee_lamports: after.formationFeeLamports.toString(),
});
