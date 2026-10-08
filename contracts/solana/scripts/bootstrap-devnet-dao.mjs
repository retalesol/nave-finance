#!/usr/bin/env node
/**
 * Headless devnet DAO bootstrap (Phase 5 fixture driver).
 *
 * Stands up ONE canonical DAO end-to-end and drives it to the point where the
 * autonomous agent pipeline can take over (status = Pending). It performs, in
 * order:
 *
 *   1.  generate-agent-keys (edge)      → 4 custodied agent pubkeys
 *   2.  initialize_dao / _extensions / _governance (nave_core)
 *   3.  register_dao_token (nave_core)
 *   4.  update_constitution (approve kamino/jito/marginfi adapters)
 *   5.  set_review_window(120)          → short oversight window for the gate run
 *   6.  register-dao (edge)             → off-chain metadata + slug
 *   7.  fund agents                     → SOL to each agent pubkey (tx fees)
 *   8.  mint + deposit_to_vault         → seed the treasury
 *   9.  init_strategy_position + init_strategy_escrow (per protocol)
 *   10. Strategy proposal → lock_tokens_and_vote → finalize_proposal
 *   11. create_execution_request        → status Pending (agents take it from here)
 *   12. index-events (edge)             → seed activity_logs for the run
 *
 * It writes a manifest to deployments/bootstrap-<dao>.json with every address,
 * the execution-request PDA, and the agent pubkeys, so run-pipeline / the gate
 * verifier can pick up the DAO without re-deriving anything.
 *
 * This script is intentionally idempotent-ish on PDAs (init_* helpers skip if
 * the account already exists) but creates a NEW DAO each run (dao_id auto-
 * increments from global_config.dao_count).
 *
 * ── Running ──────────────────────────────────────────────────────────────────
 *   node scripts/bootstrap-devnet-dao.mjs \
 *     --wallet .deploy-wallet-devnet.json \
 *     --rpc https://roseanna-tzdvmq-fast-devnet.helius-rpc.com \
 *     --name "Nave Gate DAO" --slug nave-gate
 *
 * Edge steps require these env vars (set them to enable; omit / pass
 * --skip-edge to run the on-chain bootstrap only):
 *   SUPABASE_FUNCTIONS_URL   e.g. https://<ref>.supabase.co/functions/v1
 *                            (or set SUPABASE_URL and it is derived)
 *   SUPABASE_ANON_KEY        anon/publishable key for the Authorization header
 *   NAVE_INDEXER_SECRET      gates index-events
 *
 * --local-agents generates the 4 agent keypairs LOCALLY (writing their secret
 * keys into the manifest) instead of calling generate-agent-keys. Use only when
 * the edge custody path is not wired; the signer service will NOT have these
 * keys unless you import them.
 *
 * NOTE on sequencing: agent pubkeys are set at initialize_dao, so they must be
 * generated FIRST. generate-agent-keys binds to the founder by accepting the
 * canonical DAO PDA (["dao", creator_wallet, dao_id]) before the account exists
 * (we pass dao_id below); once the DAO exists it falls back to the strict
 * on-chain founder check. --local-agents remains as a no-edge fallback (signer
 * custody NOT wired in that mode).
 */
import { createPrivateKey, sign as edSign, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";
import bs58 from "bs58";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const IDL_DIR = existsSync(join(ROOT, "idl")) ? join(ROOT, "idl") : join(ROOT, "target", "idl");

const DEFAULT_RPC = "https://roseanna-tzdvmq-fast-devnet.helius-rpc.com";

// Adapter program ids (match .env.example / deployed adapters).
const ADAPTERS = {
  kamino: "B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD",
  jito: "E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT",
  marginfi: "Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7",
};

// Token economics (6 decimals). Voter holds the supermajority so a single FOR
// vote clears the 35% quorum with margin; founder seeds a modest treasury.
const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const VOTER_MINT = 10_000_000n * UNIT;
const FOUNDER_MINT = 1_000_000n * UNIT;
const TREASURY_DEPOSIT = 100_000n * UNIT;
const VOTE_LOCK = 6_000_000n * UNIT;
const STRATEGY_AMOUNT = 10_000n * UNIT; // < kamino 40% cap of treasury
const REVIEW_WINDOW_SECS = 120;
const VOTING_PERIOD_SECS = 8;
// Seed each of the 4 agent wallets at creation. DAO creation is now FEE-FREE
// (the protocol takes no SOL profit at formation; the old 2 SOL / 0.01 SOL
// formation fee is removed). Instead the founder locks a recoverable $99-of-NAVE
// stake via `stake_dao_creation`. This bootstrap only funds the 4 agent wallets
// for tx fees (0.01 SOL each = 0.04 SOL total).
const AGENT_FUND_SOL = 0.01;
const VOTER_FUND_SOL = 0.15;

// ── DAO creation stake (Phase 3) ─────────────────────────────────────────────
// Devnet NAVE replica mint (6 decimals). Fixed devnet price $10 ⇒ $99 stake =
// 9.9 NAVE = 9_900_000 base units. The stake step is best-effort: it runs only
// when the founder already holds >= the stake amount of this NAVE mint, since
// the bootstrap founder is an arbitrary devnet wallet that may not hold NAVE.
const DEVNET_NAVE_MINT = "GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa";
const DAO_STAKE_NAVE_BASE_UNITS = 9_900_000n; // 9.9 NAVE @ 6 decimals
const DAO_STAKE_PRICE_USD_MICRO = 10_000_000n; // $10 devnet fixed price

const VOTE_FOR = 0;
const STRATEGY_PROTOCOL = "kamino";
const APPROVED_PROTOCOLS = ["kamino", "jito", "marginfi"];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    walletPath: null,
    rpc: DEFAULT_RPC,
    name: "Nave Gate DAO",
    slug: null,
    skipEdge: false,
    localAgents: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wallet") out.walletPath = args[++i];
    else if (a === "--rpc") out.rpc = args[++i];
    else if (a === "--name") out.name = args[++i];
    else if (a === "--slug") out.slug = args[++i];
    else if (a === "--skip-edge") out.skipEdge = true;
    else if (a === "--local-agents") out.localAgents = true;
  }
  if (!out.walletPath) {
    console.error("Missing --wallet <path-to-keypair.json>");
    process.exit(1);
  }
  if (!out.slug) {
    out.slug = `nave-gate-${Date.now().toString(36)}`;
  }
  return out;
}

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadIdl(name) {
  const p = join(IDL_DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`IDL not found: ${p} (run anchor build / sync idl/)`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Detached Ed25519 signature over `message`, base58-encoded, from a Solana
 *  64-byte secret key — verifiable by the edge functions' nacl.sign.detached. */
function signMessageBase58(message, secretKey64) {
  const seed = Buffer.from(secretKey64.slice(0, 32));
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const keyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = edSign(null, Buffer.from(message), keyObject);
  return bs58.encode(sig);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

/** Canonical NE-7 strategy payload: protocol_program(32) ‖ amount u64 LE(8) ‖ mint(32).
 *  Audit ABI: the payload now binds the asset mint so create_execution_request's
 *  recomputed hash matches and the executor cannot substitute another mint. */
function strategyPayload(protocolProgram, amount, mint) {
  const buf = Buffer.alloc(72);
  protocolProgram.toBuffer().copy(buf, 0);
  buf.writeBigUInt64LE(amount, 32);
  mint.toBuffer().copy(buf, 40);
  return buf;
}

function pda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveEdgeBase() {
  const explicit = process.env.SUPABASE_FUNCTIONS_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = process.env.SUPABASE_URL?.trim();
  if (base) return `${base.replace(/\/$/, "")}/functions/v1`;
  return null;
}

async function callEdge(base, fn, body, headers = {}) {
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  const res = await fetch(`${base}/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anon ? { Authorization: `Bearer ${anon}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${fn} → HTTP ${res.status}: ${data?.error ?? JSON.stringify(data)}`);
  }
  return data;
}

async function transferSol(connection, from, toPubkey, sol) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey,
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    }),
  );
  const sig = await connection.sendTransaction(tx, [from]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  const opts = parseArgs();
  const founder = loadKeypair(opts.walletPath);
  const connection = new Connection(opts.rpc, "confirmed");

  console.log("═══════════════════════════════════════════════════");
  console.log("  Nave — Devnet DAO Bootstrap (Phase 5 fixture)");
  console.log("═══════════════════════════════════════════════════");
  console.log(`RPC:     ${opts.rpc}`);
  console.log(`Founder: ${founder.publicKey.toBase58()}`);

  const balance = (await connection.getBalance(founder.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`Balance: ${balance.toFixed(4)} SOL`);
  if (balance < 0.5) {
    throw new Error(`Founder balance too low (${balance.toFixed(4)} SOL). Need ~0.5+ SOL (creation is fee-free; covers 0.04 SOL agent seeding + voter funding + rents + the NAVE stake escrow rent).`);
  }

  // ── Programs ────────────────────────────────────────────────────────────
  const wallet = new Wallet(founder);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });
  const core = new Program(loadIdl("nave_core"), provider);
  const governance = new Program(loadIdl("nave_governance"), provider);
  const execution = new Program(loadIdl("nave_execution"), provider);
  const corePid = core.programId;

  const kaminoProgram = new PublicKey(ADAPTERS.kamino);
  const jitoProgram = new PublicKey(ADAPTERS.jito);
  const marginfiProgram = new PublicKey(ADAPTERS.marginfi);
  const strategyProgram = kaminoProgram;

  // ── Global config (must already exist from deploy) ──────────────────────
  const globalConfig = pda([Buffer.from("global_config")], corePid);
  const protocolFeeVault = pda([Buffer.from("protocol_fee_vault")], corePid);
  const gc = await core.account.naveGlobalConfig.fetchNullable(globalConfig);
  if (!gc) {
    throw new Error(`global_config not found at ${globalConfig.toBase58()} — deploy + init first (instant-deploy.mjs).`);
  }
  const daoId = gc.daoCount; // BN
  const protocolTreasury = new PublicKey(gc.treasury);
  console.log(`Global config: ${globalConfig.toBase58()}  (next dao_id=${daoId.toString()})`);

  // ── DAO PDAs ────────────────────────────────────────────────────────────
  const daoIdBuf = daoId.toArrayLike(Buffer, "le", 8);
  const daoRegistry = pda([Buffer.from("dao"), founder.publicKey.toBuffer(), daoIdBuf], corePid);
  const vaultAuthority = pda([Buffer.from("vault_authority"), daoRegistry.toBuffer()], corePid);
  const treasuryVault = pda([Buffer.from("treasury_vault"), daoRegistry.toBuffer()], corePid);
  const agentSet = pda([Buffer.from("agent_set"), daoRegistry.toBuffer()], corePid);
  const feeConfig = pda([Buffer.from("fee_config"), daoRegistry.toBuffer()], corePid);
  const guardianConfig = pda([Buffer.from("guardian_config"), daoRegistry.toBuffer()], corePid);
  const constitution = pda([Buffer.from("constitution"), daoRegistry.toBuffer()], corePid);
  const tokenRegistry = pda([Buffer.from("token_registry"), daoRegistry.toBuffer()], corePid);
  console.log(`DAO registry:  ${daoRegistry.toBase58()}`);

  // ── 1. Agent keys ───────────────────────────────────────────────────────
  const edgeBase = opts.skipEdge ? null : resolveEdgeBase();
  const creatorSignature = signMessageBase58(daoRegistry.toBase58(), founder.secretKey);

  let agentPubkeys; // [executive, financial, oversight, operational]
  let localAgentSecrets = null;

  if (opts.localAgents || !edgeBase) {
    if (!opts.localAgents) {
      console.warn("⚠️  No edge config — generating agent keys LOCALLY (signer custody NOT wired).");
    }
    const kps = Array.from({ length: 4 }, () => Keypair.generate());
    agentPubkeys = kps.map((k) => k.publicKey);
    localAgentSecrets = {
      executive: Array.from(kps[0].secretKey),
      financial: Array.from(kps[1].secretKey),
      oversight: Array.from(kps[2].secretKey),
      operational: Array.from(kps[3].secretKey),
    };
    console.log("🔑 Agent keys (local):");
  } else {
    console.log("🔑 generate-agent-keys (edge)…");
    const resp = await callEdge(edgeBase, "generate-agent-keys", {
      dao_address: daoRegistry.toBase58(),
      creator_wallet: founder.publicKey.toBase58(),
      creator_signature: creatorSignature,
      dao_id: Number(daoId.toString()),
    });
    agentPubkeys = [
      new PublicKey(resp.agents.executive.pubkey),
      new PublicKey(resp.agents.financial.pubkey),
      new PublicKey(resp.agents.oversight.pubkey),
      new PublicKey(resp.agents.operational.pubkey),
    ];
  }
  console.log(`   executive   ${agentPubkeys[0].toBase58()}`);
  console.log(`   financial   ${agentPubkeys[1].toBase58()}`);
  console.log(`   oversight   ${agentPubkeys[2].toBase58()}`);
  console.log(`   operational ${agentPubkeys[3].toBase58()}`);

  // ── Vault mint (founder is mint authority for the fixture) ───────────────
  console.log("🪙 Creating vault mint…");
  const vaultMint = await createMint(connection, founder, founder.publicKey, null, DECIMALS);
  console.log(`   mint ${vaultMint.toBase58()}`);
  const feeRecipientAta = getAssociatedTokenAddressSync(vaultMint, founder.publicKey);
  const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);

  const params = {
    name: opts.name,
    guardianWallets: [founder.publicKey],
    guardianThreshold: 1,
    agentAuthorities: agentPubkeys,
    managementFeeBps: 100,
    performanceFeeBps: 200,
    frozenManagementFeeBps: 50,
    frozenPerformanceFeeBps: 100,
    privacyMode: 0,
    feeRecipient: feeRecipientAta,
    // Audit ABI: initialize_dao now requires a non-default protocol revenue
    // wallet (receives the performance skim + annual management fee). The
    // founder doubles as the revenue wallet for the devnet fixture.
    protocolRevenueWallet: founder.publicKey,
    quorumBps: 3500,
    governanceType: 1, // token-weighted
  };

  // ── 2. initialize_dao / extensions / governance ─────────────────────────
  console.log("🏛  initialize_dao…");
  await core.methods
    .initializeDao(params)
    .accountsPartial({
      founder: founder.publicKey,
      globalConfig,
      protocolTreasury,
      daoRegistry,
      vaultAuthority,
      treasuryVault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("🏛  initialize_dao_extensions…");
  await core.methods
    .initializeDaoExtensions(params)
    .accountsPartial({
      founder: founder.publicKey,
      globalConfig,
      daoRegistry,
      treasuryVault,
      vaultAuthority,
      vaultTokenAccount,
      vaultMint,
      agentSet,
      feeConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      createAssociatedTokenAccountInstruction(founder.publicKey, vaultTokenAccount, vaultAuthority, vaultMint),
    ])
    .rpc();

  console.log("🏛  initialize_dao_governance…");
  await core.methods
    .initializeDaoGovernance(params)
    .accountsPartial({
      founder: founder.publicKey,
      globalConfig,
      daoRegistry,
      guardianConfig,
      constitution,
      tokenRegistry,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // ── 2b. stake_dao_creation (Phase 3, best-effort) ────────────────────────
  // Creation is fee-free; lock the recoverable $99-of-NAVE stake when the
  // founder holds enough of the devnet NAVE replica. Skipped (non-fatal) when
  // the founder has no NAVE balance — the DAO is still created fee-free.
  const daoStakeLock = pda([Buffer.from("dao_stake_lock"), daoRegistry.toBuffer()], corePid);
  const stakeEscrow = pda([Buffer.from("stake_escrow"), daoRegistry.toBuffer()], corePid);
  let stakeRecorded = null;
  try {
    const naveMint = new PublicKey(DEVNET_NAVE_MINT);
    const founderNaveAta = getAssociatedTokenAddressSync(naveMint, founder.publicKey);
    let naveBalance = 0n;
    try {
      const acc = await getAccount(connection, founderNaveAta);
      naveBalance = acc.amount;
    } catch {
      naveBalance = 0n;
    }
    if (naveBalance >= DAO_STAKE_NAVE_BASE_UNITS) {
      console.log(`🔒 stake_dao_creation (${Number(DAO_STAKE_NAVE_BASE_UNITS) / 1e6} NAVE)…`);
      await core.methods
        .stakeDaoCreation(new BN(DAO_STAKE_NAVE_BASE_UNITS.toString()), new BN(DAO_STAKE_PRICE_USD_MICRO.toString()))
        .accountsPartial({
          founder: founder.publicKey,
          globalConfig,
          daoRegistry,
          naveMint,
          founderNaveAccount: founderNaveAta,
          daoStakeLock,
          stakeEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      stakeRecorded = {
        naveMint: naveMint.toBase58(),
        daoStakeLock: daoStakeLock.toBase58(),
        stakeEscrow: stakeEscrow.toBase58(),
        amountBaseUnits: DAO_STAKE_NAVE_BASE_UNITS.toString(),
      };
      console.log(`   ✓ staked → escrow ${stakeEscrow.toBase58()}`);
    } else {
      console.warn(
        `⚠️  NAVE stake skipped (founder holds ${Number(naveBalance) / 1e6} NAVE; need ` +
          `${Number(DAO_STAKE_NAVE_BASE_UNITS) / 1e6}). Creation is fee-free; fund the founder ` +
          `with the devnet NAVE mint to enforce the $99 stake.`,
      );
    }
  } catch (e) {
    console.warn(`⚠️  stake_dao_creation failed (non-fatal): ${e.message}`);
  }

  // ── 3. register_dao_token ───────────────────────────────────────────────
  console.log("🪙 register_dao_token…");
  await core.methods
    .registerDaoToken(opts.name.slice(0, 16), "NAVE", DECIMALS, false, new anchor.BN(0))
    .accountsPartial({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      tokenRegistry,
      vaultAuthority,
      treasuryVault,
      destination: vaultTokenAccount,
      protocolFeeVault,
      mint: vaultMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // ── 4. update_constitution (approve adapters) ────────────────────────────
  console.log("📜 update_constitution…");
  await core.methods
    .updateConstitution(
      [
        { protocolId: "kamino", programId: kaminoProgram, maxAllocationBps: 4000, approved: true },
        { protocolId: "jito", programId: jitoProgram, maxAllocationBps: 3000, approved: true },
        { protocolId: "marginfi", programId: marginfiProgram, maxAllocationBps: 3000, approved: true },
      ],
      null,
      null,
    )
    .accountsPartial({ authority: founder.publicKey, globalConfig, daoRegistry, constitution })
    .rpc();

  // ── 5. set_review_window(120) ────────────────────────────────────────────
  console.log(`⏲  set_review_window(${REVIEW_WINDOW_SECS})…`);
  await core.methods
    .setReviewWindow(new BN(REVIEW_WINDOW_SECS))
    .accountsPartial({ authority: founder.publicKey, globalConfig, daoRegistry, constitution })
    .rpc();

  // ── 6. register-dao (edge metadata) ──────────────────────────────────────
  if (edgeBase) {
    console.log("🌐 register-dao (edge)…");
    try {
      await callEdge(edgeBase, "register-dao", {
        dao_address: daoRegistry.toBase58(),
        creator_wallet: founder.publicKey.toBase58(),
        creator_signature: creatorSignature,
        name: opts.name,
        governance_type: "token",
        dao_id: Number(daoId.toString()),
        slug: opts.slug,
      });
      console.log(`   ✓ registered slug=${opts.slug}`);
    } catch (e) {
      console.warn(`   ⚠️  register-dao failed (non-fatal): ${e.message}`);
    }
  }

  // ── 7. fund agents ───────────────────────────────────────────────────────
  console.log("⛽ funding agents…");
  for (const ap of agentPubkeys) {
    await transferSol(connection, founder, ap, AGENT_FUND_SOL);
  }

  // ── 8. mint + deposit_to_vault ───────────────────────────────────────────
  console.log("💰 minting tokens + seeding treasury…");
  const voter = Keypair.generate();
  await transferSol(connection, founder, voter.publicKey, VOTER_FUND_SOL);

  const voterAtaAcc = await getOrCreateAssociatedTokenAccount(connection, founder, vaultMint, voter.publicKey);
  const voterAta = voterAtaAcc.address;
  const founderAtaAcc = await getOrCreateAssociatedTokenAccount(connection, founder, vaultMint, founder.publicKey);
  const founderAta = founderAtaAcc.address;

  await mintTo(connection, founder, vaultMint, voterAta, founder, VOTER_MINT);
  await mintTo(connection, founder, vaultMint, founderAta, founder, FOUNDER_MINT);

  // Audit ABI: the treasury now uses the per-asset model. Register the vault
  // mint as a $1 stablecoin (ZERO feed, kind=0), deposit into its dedicated
  // asset_vault (which is what execute_strategy pulls from — treasury_asset
  // .token_account), then revalue_treasury to set the aggregate micro-USD NAV.
  const ZERO_FEED = new Array(32).fill(0);
  const assetConfig = pda([Buffer.from("asset_config"), daoRegistry.toBuffer(), vaultMint.toBuffer()], corePid);
  const treasuryAsset = pda([Buffer.from("treasury_asset"), daoRegistry.toBuffer(), vaultMint.toBuffer()], corePid);
  const assetVault = pda([Buffer.from("asset_vault"), daoRegistry.toBuffer(), vaultMint.toBuffer()], corePid);
  console.log("🪙 register_asset (stablecoin)…");
  await core.methods
    .registerAsset(ZERO_FEED, true, 0)
    .accountsPartial({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: vaultMint,
      vaultAuthority,
      treasuryVault,
      assetConfig,
      treasuryAsset,
      assetVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("🏦 deposit_to_asset…");
  await core.methods
    .depositToAsset(new BN(TREASURY_DEPOSIT.toString()))
    .accountsPartial({
      depositor: founder.publicKey,
      daoRegistry,
      mint: vaultMint,
      assetConfig,
      treasuryAsset,
      assetVault,
      depositorTokenAccount: founderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("💱 revalue_treasury (set NAV)…");
  await core.methods
    .revalueTreasury()
    .accountsPartial({ authority: founder.publicKey, globalConfig, daoRegistry, agentSet, treasuryVault })
    .remainingAccounts([
      { pubkey: assetConfig, isSigner: false, isWritable: false },
      { pubkey: treasuryAsset, isSigner: false, isWritable: true },
      { pubkey: assetVault, isSigner: false, isWritable: false },
      { pubkey: assetVault, isSigner: false, isWritable: false },
    ])
    .rpc();

  // ── 9. init_strategy_position + init_strategy_escrow (all approved) ──────
  console.log("🧩 init_strategy_position + init_strategy_escrow (all protocols) …");
  const strategyAccounts = {};
  for (const protocolId of APPROVED_PROTOCOLS) {
    // Audit ABI: strategy PDAs are now keyed per (dao, protocol, mint).
    const strategyPosition = pda(
      [Buffer.from("strategy_position"), daoRegistry.toBuffer(), Buffer.from(protocolId), vaultMint.toBuffer()],
      corePid,
    );
    const strategyEscrow = pda(
      [Buffer.from("strategy_escrow"), daoRegistry.toBuffer(), Buffer.from(protocolId), vaultMint.toBuffer()],
      corePid,
    );

    try {
      await core.methods
        .initStrategyPosition(protocolId)
        .accountsPartial({
          authority: founder.publicKey,
          globalConfig,
          daoRegistry,
          mint: vaultMint,
          strategyPosition,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("already in use")) throw err;
    }

    try {
      // Audit ABI: init_strategy_escrow now binds the per-asset treasury_asset
      // (auto-derived by Anchor from dao+mint) rather than the legacy
      // treasury_vault/vault_token_account pair.
      await core.methods
        .initStrategyEscrow(protocolId)
        .accountsPartial({
          authority: founder.publicKey,
          globalConfig,
          daoRegistry,
          vaultAuthority,
          treasuryAsset,
          mint: vaultMint,
          strategyEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("already in use")) throw err;
    }

    strategyAccounts[protocolId] = {
      strategyPosition: strategyPosition.toBase58(),
      strategyEscrow: strategyEscrow.toBase58(),
    };
  }

  // ── 10. Strategy proposal → vote → finalize ──────────────────────────────
  console.log("🗳  creating Strategy proposal…");
  const registry = await core.account.daoRegistry.fetch(daoRegistry);
  const proposalIndex = registry.proposalCount; // BN
  const proposal = pda(
    [Buffer.from("proposal"), daoRegistry.toBuffer(), proposalIndex.toArrayLike(Buffer, "le", 8)],
    governance.programId,
  );
  const payload = strategyPayload(strategyProgram, STRATEGY_AMOUNT, vaultMint);
  const payloadHash = sha256(payload);

  await governance.methods
    .createProposal({
      title: "Deploy to Kamino",
      description: "Bootstrap strategy: deploy treasury capital to Kamino.",
      payload,
      proposalType: 1, // Strategy
      votingPeriodSeconds: new BN(VOTING_PERIOD_SECS),
    })
    .accountsPartial({ proposer: founder.publicKey, daoRegistry, proposal, daoTokenMint: vaultMint })
    .rpc();

  console.log("🗳  lock_tokens_and_vote (FOR)…");
  const voteEscrow = pda([Buffer.from("vote_escrow"), proposal.toBuffer(), voter.publicKey.toBuffer()], governance.programId);
  const voteRecord = pda([Buffer.from("vote_record"), proposal.toBuffer(), voter.publicKey.toBuffer()], governance.programId);
  const escrowTokenAccount = getAssociatedTokenAddressSync(vaultMint, voteEscrow, true);
  await governance.methods
    .lockTokensAndVote(new BN(VOTE_LOCK.toString()), VOTE_FOR)
    .accountsPartial({
      voter: voter.publicKey,
      globalConfig,
      daoRegistry,
      proposal,
      daoTokenMint: vaultMint,
      voterTokenAccount: voterAta,
      escrowTokenAccount,
      voteEscrow,
      voteRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      createAssociatedTokenAccountInstruction(founder.publicKey, escrowTokenAccount, voteEscrow, vaultMint),
    ])
    .signers([voter])
    .rpc();

  console.log("⏳ waiting for voting period to end…");
  const prop = await governance.account.proposal.fetch(proposal);
  const slot = await connection.getSlot("confirmed");
  const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const waitMs = (prop.votingEnd.toNumber() - blockTime) * 1000 + 2500;
  if (waitMs > 0) await sleep(waitMs);

  console.log("✅ finalize_proposal…");
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await governance.methods
        .finalizeProposal()
        .accountsPartial({ authority: founder.publicKey, globalConfig, daoRegistry, proposal })
        .rpc();
      break;
    } catch (err) {
      if (!String(err).includes("VotingPeriodNotEnded") || attempt === 5) throw err;
      await sleep(1000);
    }
  }
  const finalized = await governance.account.proposal.fetch(proposal);
  console.log(`   proposal status: ${JSON.stringify(finalized.status)}`);

  // ── 11. create_execution_request → Pending ───────────────────────────────
  console.log("📨 create_execution_request…");
  const executionRequest = pda([Buffer.from("execution_request"), proposal.toBuffer()], execution.programId);
  await execution.methods
    .createExecutionRequest(new BN(STRATEGY_AMOUNT.toString()), strategyProgram, vaultMint)
    .accountsPartial({
      creator: founder.publicKey,
      globalConfig,
      daoRegistry,
      proposal,
      constitution,
      treasuryVault,
      executionRequest,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`   execution request: ${executionRequest.toBase58()} (status Pending)`);

  // ── 12. index-events (edge) ───────────────────────────────────────────────
  if (edgeBase && process.env.NAVE_INDEXER_SECRET) {
    console.log("🌐 index-events (edge)…");
    try {
      const nowIso = new Date().toISOString();
      const curSlot = await connection.getSlot("confirmed");
      await callEdge(edgeBase, "index-events", {
        indexer_secret: process.env.NAVE_INDEXER_SECRET,
        events: [
          {
            dao_onchain_address: daoRegistry.toBase58(),
            event_type: "dao_initialized",
            description: `DAO ${opts.name} bootstrapped`,
            actor: founder.publicKey.toBase58(),
            tx_signature: `bootstrap-${daoRegistry.toBase58().slice(0, 8)}`,
            slot: curSlot,
            block_time: nowIso,
          },
          {
            dao_onchain_address: daoRegistry.toBase58(),
            event_type: "execution_request_created",
            description: `Execution request ${executionRequest.toBase58()} created (Pending)`,
            actor: founder.publicKey.toBase58(),
            tx_signature: `bootstrap-er-${executionRequest.toBase58().slice(0, 8)}`,
            slot: curSlot,
            block_time: nowIso,
            raw_data: { execution_request: executionRequest.toBase58(), amount: STRATEGY_AMOUNT.toString() },
          },
        ],
      });
      console.log("   ✓ events indexed");
    } catch (e) {
      console.warn(`   ⚠️  index-events failed (non-fatal): ${e.message}`);
    }
  } else if (edgeBase) {
    console.warn("⚠️  NAVE_INDEXER_SECRET unset — skipping index-events.");
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  const manifest = {
    cluster: "devnet",
    rpc: opts.rpc,
    createdAt: new Date().toISOString(),
    founder: founder.publicKey.toBase58(),
    daoId: Number(daoId.toString()),
    slug: opts.slug,
    name: opts.name,
    governanceType: "token",
    reviewWindowSecs: REVIEW_WINDOW_SECS,
    addresses: {
      daoRegistry: daoRegistry.toBase58(),
      globalConfig: globalConfig.toBase58(),
      vaultAuthority: vaultAuthority.toBase58(),
      treasuryVault: treasuryVault.toBase58(),
      vaultMint: vaultMint.toBase58(),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
      constitution: constitution.toBase58(),
      agentSet: agentSet.toBase58(),
      guardianConfig: guardianConfig.toBase58(),
      tokenRegistry: tokenRegistry.toBase58(),
      feeConfig: feeConfig.toBase58(),
      strategyPosition: strategyAccounts[STRATEGY_PROTOCOL].strategyPosition,
      strategyEscrow: strategyAccounts[STRATEGY_PROTOCOL].strategyEscrow,
      proposal: proposal.toBase58(),
      executionRequest: executionRequest.toBase58(),
    },
    strategy: {
      protocol: STRATEGY_PROTOCOL,
      adapterProgram: strategyProgram.toBase58(),
      amountBaseUnits: STRATEGY_AMOUNT.toString(),
      payloadHashHex: payloadHash.toString("hex"),
    },
    strategyAccounts,
    ...(stakeRecorded ? { stake: stakeRecorded } : {}),
    agents: {
      executive: agentPubkeys[0].toBase58(),
      financial: agentPubkeys[1].toBase58(),
      oversight: agentPubkeys[2].toBase58(),
      operational: agentPubkeys[3].toBase58(),
    },
    voter: voter.publicKey.toBase58(),
    ...(localAgentSecrets ? { localAgentSecrets } : {}),
  };

  const outDir = join(ROOT, "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `bootstrap-${daoRegistry.toBase58()}.json`);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ✅ Bootstrap complete — DAO ready for the agent pipeline");
  console.log("═══════════════════════════════════════════════════");
  console.log(`DAO:                ${daoRegistry.toBase58()}`);
  console.log(`Execution request:  ${executionRequest.toBase58()}  (Pending)`);
  console.log(`Manifest:           ${outPath}`);
  console.log("");
  console.log("Next: run-pipeline — trigger the agent-orchestrator to advance");
  console.log("Pending → InReview → Executed with no human signer.");
}

main().catch((err) => {
  console.error("\n❌ Bootstrap failed:", err?.message ?? err);
  if (err?.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
