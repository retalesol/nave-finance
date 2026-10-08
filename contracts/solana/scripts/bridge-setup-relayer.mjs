#!/usr/bin/env node
/**
 * NAVE bridge — Solana custody setup (trusted-relayer MVP, testnet only).
 *
 * Bridge approach: Nave-owned trusted relayer (NOT Wormhole NTT). See
 * solana/BRIDGE_RELAYER_MVP.md for the rationale. Short version: no
 * Wormhole NTT/Executor SDK is installed in any repo and the bare NTT SDK helper
 * does not expose a typed referrer-fee argument, so per the plan's decision gate
 * we ship the trusted-relayer MVP that captures the 2% fee under Nave control.
 *
 * Solana is the home chain. NAVE locks/releases here in "lock mode":
 *   • Solana → EVM (lock):  user transfers NAVE into the custody token account
 *     created by this script; the relayer mints WrappedNave on the EVM chain.
 *   • EVM → Solana (release): user burns WrappedNave; the relayer transfers NAVE
 *     out of custody back to the user (minus the 2% fee).
 *
 * This script is the minimal Solana-side setup the relayer needs: it creates
 * (idempotently) the NAVE custody token account owned by a Nave-controlled
 * custody authority, optionally creates the Nave fee-wallet NAVE ATA, and writes
 * a `bridge` block into deployments/devnet.json that the app + signer-service
 * read. No custom Anchor program is required for the trusted-relayer MVP — lock
 * is a plain SPL transfer into custody and release is an SPL transfer out signed
 * by the custody authority (held by the signer-service).
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *   node scripts/bridge-setup-relayer.mjs --wallet .deploy-wallet-devnet.json
 *
 * Flags:
 *   --wallet <path>             payer/fee-payer keypair (default: .deploy-wallet-devnet.json)
 *   --custody-authority <path>  keypair that OWNS the custody token account and
 *                               signs releases (default: same as --wallet). The
 *                               signer-service must hold this secret key.
 *   --fee-wallet <pubkey>       Solana NAVE fee wallet owner (default: custody authority)
 *   --rpc <url>                 devnet RPC (default from deployments/devnet.json)
 *   --mint <pubkey>            NAVE mint override (default: devnet replica from devnet.json)
 *   --dry-run                   compute + print addresses and config only; send no txs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEPLOYMENTS = join(ROOT, "deployments", "devnet.json");

const BRIDGE_FEE_BPS = Number(process.env.NAVE_BRIDGE_FEE_BPS || 200);
const BRIDGE_FEE_DBPS = BRIDGE_FEE_BPS * 10;

// Testnet routes covered by the MVP: Solana devnet <-> Sepolia / Base Sepolia.
const EVM_TESTNET_CHAIN_IDS = [11155111, 84532];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    walletPath: ".deploy-wallet-devnet.json",
    custodyAuthorityPath: null,
    feeWallet: null,
    rpc: null,
    mint: null,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wallet") out.walletPath = args[++i];
    else if (a === "--custody-authority") out.custodyAuthorityPath = args[++i];
    else if (a === "--fee-wallet") out.feeWallet = args[++i];
    else if (a === "--rpc") out.rpc = args[++i];
    else if (a === "--mint") out.mint = args[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function loadKeypair(path) {
  const abs = resolve(ROOT, path.replace(/^~\//, `${process.env.HOME || ""}/`));
  if (!existsSync(abs)) {
    throw new Error(`Keypair not found: ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadDeployments() {
  if (!existsSync(DEPLOYMENTS)) {
    throw new Error(`deployments/devnet.json not found at ${DEPLOYMENTS}`);
  }
  return JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
}

async function main() {
  const opts = parseArgs();
  const deployments = loadDeployments();

  const rpc = opts.rpc || deployments.rpc || deployments.rpcApp;
  if (!rpc) throw new Error("No RPC configured (pass --rpc or set deployments/devnet.json rpc).");

  const naveMint = new PublicKey(
    opts.mint || deployments.naveToken?.devnetReplicaMint,
  );
  const decimals = Number(deployments.naveToken?.decimals ?? 6);

  const payer = loadKeypair(opts.walletPath);
  const custodyAuthority = opts.custodyAuthorityPath
    ? loadKeypair(opts.custodyAuthorityPath)
    : payer;
  const feeWalletOwner = opts.feeWallet
    ? new PublicKey(opts.feeWallet)
    : custodyAuthority.publicKey;

  // Custody + fee token accounts are ATAs of the classic SPL token program (the
  // devnet replica mint was created with createMint / TOKEN_PROGRAM_ID).
  const custodyTokenAccount = getAssociatedTokenAddressSync(
    naveMint,
    custodyAuthority.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const feeWalletTokenAccount = getAssociatedTokenAddressSync(
    naveMint,
    feeWalletOwner,
    true,
    TOKEN_PROGRAM_ID,
  );

  console.log("NAVE bridge — Solana custody setup (trusted-relayer MVP, testnet)");
  console.log(`  rpc:                 ${rpc}`);
  console.log(`  nave mint:           ${naveMint.toBase58()} (${decimals} decimals)`);
  console.log(`  payer:               ${payer.publicKey.toBase58()}`);
  console.log(`  custody authority:   ${custodyAuthority.publicKey.toBase58()}`);
  console.log(`  custody token acct:  ${custodyTokenAccount.toBase58()}`);
  console.log(`  fee wallet owner:    ${feeWalletOwner.toBase58()}`);
  console.log(`  fee wallet token:    ${feeWalletTokenAccount.toBase58()}`);
  console.log(`  fee:                 ${BRIDGE_FEE_BPS} bps (${BRIDGE_FEE_BPS / 100}%) / ${BRIDGE_FEE_DBPS} dbps`);

  const connection = new Connection(rpc, "confirmed");

  if (!opts.dryRun) {
    // getOrCreateAssociatedTokenAccount is idempotent: it creates the ATA only
    // when missing and returns the existing account otherwise.
    const custody = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      naveMint,
      custodyAuthority.publicKey,
      true,
      "confirmed",
      undefined,
      TOKEN_PROGRAM_ID,
    );
    console.log(`  ✓ custody token account ready: ${custody.address.toBase58()}`);

    const feeAcct = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      naveMint,
      feeWalletOwner,
      true,
      "confirmed",
      undefined,
      TOKEN_PROGRAM_ID,
    );
    console.log(`  ✓ fee wallet token account ready: ${feeAcct.address.toBase58()}`);

    // Sanity read so we fail loudly if the accounts are not the NAVE mint.
    const custodyInfo = await getAccount(connection, custody.address, "confirmed", TOKEN_PROGRAM_ID);
    if (!custodyInfo.mint.equals(naveMint)) {
      throw new Error(
        `Custody token account ${custody.address.toBase58()} is not for the NAVE mint.`,
      );
    }
  } else {
    console.log("  (dry run — no transactions sent)");
  }

  // Preserve any EVM addresses already recorded so re-running Solana setup does
  // not clobber the EVM side that the Foundry deploy writes.
  const existingEvm = deployments.bridge?.evm ?? {};
  const wrappedNave = { ...(existingEvm.wrappedNave ?? {}) };
  for (const id of EVM_TESTNET_CHAIN_IDS) {
    if (!(id in wrappedNave)) wrappedNave[id] = "";
  }

  deployments.bridge = {
    approach: "trusted-relayer-mvp",
    scope: "testnet",
    network: "devnet",
    feeBps: BRIDGE_FEE_BPS,
    feeDbps: BRIDGE_FEE_DBPS,
    solana: {
      naveMint: naveMint.toBase58(),
      decimals,
      custodyAuthority: custodyAuthority.publicKey.toBase58(),
      custodyTokenAccount: custodyTokenAccount.toBase58(),
      feeWallet: feeWalletOwner.toBase58(),
      feeWalletTokenAccount: feeWalletTokenAccount.toBase58(),
    },
    evm: {
      // Filled in by evm/script/DeployWrappedNave.s.sol + operator.
      wrappedNave,
      minter: existingEvm.minter ?? "",
      feeWallet: existingEvm.feeWallet ?? "",
    },
    routes: [
      { from: "solana", to: "ethereum", evmChainId: 11155111 },
      { from: "solana", to: "base", evmChainId: 84532 },
      { from: "ethereum", to: "solana", evmChainId: 11155111 },
      { from: "base", to: "solana", evmChainId: 84532 },
    ],
    updatedAt: new Date().toISOString(),
  };

  if (!opts.dryRun) {
    writeFileSync(DEPLOYMENTS, `${JSON.stringify(deployments, null, 2)}\n`);
    console.log(`  ✓ wrote bridge block to deployments/devnet.json`);
  } else {
    console.log("  bridge block (dry run, not written):");
    console.log(JSON.stringify(deployments.bridge, null, 2));
  }

  console.log("");
  console.log("Next: configure these env vars for the relayer + app:");
  console.log("  signer-service:");
  console.log(`    BRIDGE_RELAYER_ENABLED=true`);
  console.log(`    BRIDGE_SOLANA_NAVE_MINT=${naveMint.toBase58()}`);
  console.log(`    BRIDGE_SOLANA_CUSTODY=${custodyTokenAccount.toBase58()}`);
  console.log(`    BRIDGE_SOLANA_FEE_WALLET=${feeWalletOwner.toBase58()}`);
  console.log(`    BRIDGE_SOLANA_CUSTODY_AUTHORITY=<custody authority secret key>`);
  console.log("  nave-app:");
  console.log(`    VITE_NAVE_BRIDGE_RELAYER_URL=<signer-service url>`);
  console.log(`    VITE_NAVE_BRIDGE_SOLANA_CUSTODY=${custodyTokenAccount.toBase58()}`);
  console.log(`    VITE_NAVE_BRIDGE_FEE_PAYEE_SOLANA=${feeWalletOwner.toBase58()}`);
  console.log("");
  console.log("Then deploy WrappedNave on Sepolia + Base Sepolia and record the");
  console.log("addresses under bridge.evm.wrappedNave (see DeployWrappedNave.s.sol).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
