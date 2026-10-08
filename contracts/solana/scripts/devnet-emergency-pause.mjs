#!/usr/bin/env node
/** DEVNET: founder calls emergency_pause_agents (instant, no M-of-N) and we
 *  read back dao_registry.agents_enabled to prove the kill-switch flips. */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet } = anchorPkg;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const dao = new PublicKey(arg("--dao", null));
const rpc = arg("--rpc", "https://api.devnet.solana.com");
const walletPath = arg("--wallet", new URL("../.deploy-wallet-devnet.json", import.meta.url).pathname);
const founder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const conn = new Connection(rpc, "confirmed");
const provider = new AnchorProvider(conn, new Wallet(founder), { commitment: "confirmed" });
const idl = JSON.parse(readFileSync(new URL("../idl/nave_core.json", import.meta.url).pathname, "utf8"));
const core = new Program(idl, provider);
const corePid = core.programId;
const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], corePid);
const [agentSet] = PublicKey.findProgramAddressSync([Buffer.from("agent_set"), dao.toBuffer()], corePid);

const before = await core.account.daoRegistry.fetch(dao);
console.log("before: dao_registry.agents_enabled =", before.agentsEnabled);
const sig = await core.methods
  .emergencyPauseAgents()
  .accountsPartial({ authority: founder.publicKey, globalConfig, daoRegistry: dao, agentSet })
  .rpc();
console.log("emergency_pause_agents tx:", sig);
const after = await core.account.daoRegistry.fetch(dao);
console.log("after:  dao_registry.agents_enabled =", after.agentsEnabled);
const as = await core.account.agentSet.fetch(agentSet);
console.log("after:  agent_set.agents_enabled    =", as.agentsEnabled);
