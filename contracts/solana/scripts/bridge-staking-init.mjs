#!/usr/bin/env node
/**
 * NAVE bridge + staking — on-chain initialization (hardened bridge).
 *
 * Idempotent. Initializes (or skips if present):
 *   1. nave_staking.initialize_pool
 *   2. protocol-revenue NAVE ATA
 *   3. nave_bridge.initialize_config (fee 250 bps = 100/100/50)
 *   3b. set_lock_daily_cap + set_dest_chain_allowed (empty allowlist rejects every lock)
 *   4. neutral staking-fee COLLECTOR token account owned by the relayer
 *
 * staking_pool_owner is set to the RELAYER (collector owner), matching the
 * staking-mirror cutover model — not the pool-authority PDA.
 *
 * ── Mainnet (skip Safe/Ledger handoff; you stay owner) ───────────────────────
 *   node scripts/bridge-staking-init.mjs \
 *     --wallet /path/to/solana-deploy-wallet.json \
 *     --relayer /path/to/solana-relayer.json \
 *     --owner GdRMR… \
 *     --protocol GdRMR… \
 *     --rpc "$MAINNET_RPC_URL" \
 *     --mint EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory \
 *     --deployments deployments/mainnet.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const BRIDGE_PROGRAM_ID = new PublicKey("Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6");
const STAKING_PROGRAM_ID = new PublicKey("AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf");
const DEFAULT_PROTOCOL_WALLET = "6N5JiWP2zF6VXhG6hwgYEYhxBEARAV5P6WRgfYb2zskC";

const FEE_BPS = 250;
const STAKING_BPS = 100;
const PROTOCOL_BPS = 100;
const BURN_BPS = 50;

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u16le(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
function resolvePath(p) {
  return isAbsolute(p) ? p : join(ROOT, p);
}
function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolvePath(path), "utf8"))));
}
function programDataAddress(programId) {
  const [pda] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER_ID);
  return pda;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    walletPath: ".deploy-wallet-devnet.json",
    relayerPath: null,
    relayerPubkey: null,
    owner: null,
    protocol: DEFAULT_PROTOCOL_WALLET,
    perTxCap: 1_000_000_000n,
    dailyCap: 25_000_000_000n,
    lockDailyCap: null,
    destChains: [],
    rpc: null,
    mint: null,
    deploymentsPath: join(ROOT, "deployments", "devnet.json"),
    collectorKeypairPath: null,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wallet") out.walletPath = args[++i];
    else if (a === "--relayer-keypair") out.relayerPath = args[++i];
    else if (a === "--relayer") out.relayerPubkey = args[++i];
    else if (a === "--owner") out.owner = args[++i];
    else if (a === "--protocol") out.protocol = args[++i];
    else if (a === "--per-tx-cap") out.perTxCap = BigInt(args[++i]);
    else if (a === "--daily-cap") out.dailyCap = BigInt(args[++i]);
    else if (a === "--lock-daily-cap") out.lockDailyCap = BigInt(args[++i]);
    else if (a === "--dest-chain") out.destChains.push(BigInt(args[++i]));
    else if (a === "--rpc") out.rpc = args[++i];
    else if (a === "--mint") out.mint = args[++i];
    else if (a === "--deployments") out.deploymentsPath = resolvePath(args[++i]);
    else if (a === "--collector-keypair") out.collectorKeypairPath = resolvePath(args[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const deployments = existsSync(args.deploymentsPath)
    ? JSON.parse(readFileSync(args.deploymentsPath, "utf8"))
    : {};
  const rpc = args.rpc || deployments.rpc;
  if (!rpc) throw new Error("Missing --rpc (and deployments file has no rpc).");
  const mintStr = args.mint || deployments.naveToken?.devnetReplicaMint || deployments.naveMint;
  if (!mintStr) throw new Error("Missing --mint.");
  const mint = new PublicKey(mintStr);

  const wallet = loadKeypair(args.walletPath);
  const owner = new PublicKey(args.owner || wallet.publicKey);
  let relayerKeypair = null;
  let relayer;
  if (args.relayerPath) {
    relayerKeypair = loadKeypair(args.relayerPath);
    relayer = relayerKeypair.publicKey;
  } else {
    relayer = new PublicKey(args.relayerPubkey || wallet.publicKey);
  }
  const protocolWallet = new PublicKey(args.protocol);

  if (owner.equals(relayer)) {
    console.warn(
      "\n  WARNING: owner == relayer (P1). Prefer --relayer-keypair with a distinct hot key before enabling the relayer.\n",
    );
  }

  const connection = new Connection(rpc, "confirmed");
  const bridgeProgramData = programDataAddress(BRIDGE_PROGRAM_ID);
  const stakingProgramData = programDataAddress(STAKING_PROGRAM_ID);

  const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool")], STAKING_PROGRAM_ID);
  const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool_authority")], STAKING_PROGRAM_ID);
  const [stakeVault] = PublicKey.findProgramAddressSync([Buffer.from("stake_vault")], STAKING_PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_vault")], STAKING_PROGRAM_ID);
  const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);
  const [custodyAuthority] = PublicKey.findProgramAddressSync([Buffer.from("bridge_custody_authority")], BRIDGE_PROGRAM_ID);
  const [custody] = PublicKey.findProgramAddressSync([Buffer.from("bridge_custody")], BRIDGE_PROGRAM_ID);
  const protocolFeeAta = getAssociatedTokenAddressSync(mint, protocolWallet, true);

  console.log("payer/upgrade-authority", wallet.publicKey.toBase58());
  console.log("nave_staking:");
  console.log(`  stake_pool      ${stakePool.toBase58()}`);
  console.log(`  pool_authority  ${poolAuthority.toBase58()}`);
  console.log(`  stake_vault     ${stakeVault.toBase58()}`);
  console.log(`  reward_vault    ${rewardVault.toBase58()}`);
  console.log("nave_bridge:");
  console.log(`  bridge_config      ${bridgeConfig.toBase58()}`);
  console.log(`  custody_authority  ${custodyAuthority.toBase58()}`);
  console.log(`  custody            ${custody.toBase58()}`);
  console.log(`  protocol fee ATA   ${protocolFeeAta.toBase58()}`);
  console.log(`  owner ${owner.toBase58()} | relayer ${relayer.toBase58()} | protocol ${protocolWallet.toBase58()}`);
  console.log(`  fee ${FEE_BPS}bps = staking ${STAKING_BPS} + protocol ${PROTOCOL_BPS} + burn ${BURN_BPS}`);
  console.log(`  per-tx cap ${args.perTxCap} | inbound daily cap ${args.dailyCap} | outbound lock daily cap ${args.lockDailyCap ?? args.dailyCap}`);
  console.log(`  dest-chain allowlist ${args.destChains.length ? args.destChains.join(",") : "(empty — all locks rejected until set)"}`);
  console.log(`  staking_pool_owner = relayer (collector model)`);

  if (args.dryRun) return;

  // ── 1. Staking pool ────────────────────────────────────────────────────
  const poolInfo = await connection.getAccountInfo(stakePool);
  if (poolInfo) {
    console.log("stake_pool already initialized — skipping.");
  } else {
    const data = Buffer.concat([disc("initialize_pool"), owner.toBuffer()]);
    const ix = new TransactionInstruction({
      programId: STAKING_PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: STAKING_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: stakingProgramData, isSigner: false, isWritable: false },
        { pubkey: stakePool, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: stakeVault, isSigner: false, isWritable: true },
        { pubkey: rewardVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log(`initialize_pool: ${sig}`);
  }

  // ── 2. Protocol-revenue ATA ────────────────────────────────────────────
  {
    const ataInfo = await connection.getAccountInfo(protocolFeeAta);
    if (ataInfo) {
      console.log(`protocol fee ATA ready: ${protocolFeeAta.toBase58()}`);
    } else {
      const ix = createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        protocolFeeAta,
        protocolWallet,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`protocol fee ATA created: ${protocolFeeAta.toBase58()} (tx ${sig})`);
    }
  }

  // ── 3. Bridge config (staking_pool_owner = relayer) ─────────────────────
  const cfgInfo = await connection.getAccountInfo(bridgeConfig);
  if (cfgInfo) {
    console.log("bridge_config already initialized — skipping.");
  } else {
    const data = Buffer.concat([
      disc("initialize_config"),
      owner.toBuffer(),
      relayer.toBuffer(),
      protocolWallet.toBuffer(),
      relayer.toBuffer(), // staking_pool_owner = relayer (owns collector)
      u16le(FEE_BPS),
      u16le(STAKING_BPS),
      u16le(PROTOCOL_BPS),
      u16le(BURN_BPS),
      u64le(args.perTxCap),
      u64le(args.dailyCap),
    ]);
    const ix = new TransactionInstruction({
      programId: BRIDGE_PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: BRIDGE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: bridgeProgramData, isSigner: false, isWritable: false },
        { pubkey: bridgeConfig, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: custodyAuthority, isSigner: false, isWritable: false },
        { pubkey: custody, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
    console.log(`initialize_config: ${sig}`);
  }

  // ── 3b. Outbound lock cap + dest-chain allowlist ────────────────────────
  // initialize_config leaves lock_daily_cap = 0 (unlimited) and an EMPTY
  // allowlist, which rejects every lock. Seed both before any user can lock.
  const lockDailyCap = args.lockDailyCap ?? args.dailyCap;
  const destChains = args.destChains.length > 0 ? args.destChains : [];
  if (destChains.length === 0) {
    console.warn(
      "\n  WARNING: no --dest-chain given. An empty allowlist rejects EVERY lock.\n" +
        "  After init, the owner must call set_dest_chain_allowed(chain_id, true)\n" +
        "  for each served EVM id (mainnet: 1, 8453, 4663; testnet: 11155111, 84532, 46630).\n",
    );
  }
  if (!wallet.publicKey.equals(owner)) {
    console.warn(
      `\n  Owner ${owner.toBase58()} != payer ${wallet.publicKey.toBase58()}.\n` +
        `  Cannot sign set_lock_daily_cap / set_dest_chain_allowed from this wallet.\n` +
        `  Have the owner (Squads) submit:\n` +
        `    set_lock_daily_cap(${lockDailyCap})\n` +
        destChains.map((id) => `    set_dest_chain_allowed(${id}, true)`).join("\n") +
        "\n",
    );
  } else {
    const ownerKeys = [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: bridgeConfig, isSigner: false, isWritable: true },
    ];
    {
      const ix = new TransactionInstruction({
        programId: BRIDGE_PROGRAM_ID,
        keys: ownerKeys,
        data: Buffer.concat([disc("set_lock_daily_cap"), u64le(lockDailyCap)]),
      });
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`set_lock_daily_cap(${lockDailyCap}): ${sig}`);
    }
    for (const chainId of destChains) {
      const ix = new TransactionInstruction({
        programId: BRIDGE_PROGRAM_ID,
        keys: ownerKeys,
        data: Buffer.concat([disc("set_dest_chain_allowed"), u64le(chainId), Buffer.from([1])]),
      });
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [wallet]);
      console.log(`set_dest_chain_allowed(${chainId}, true): ${sig}`);
    }
  }

  // ── 4. Neutral collector (token account owned by relayer) ───────────────
  const collectorPath =
    args.collectorKeypairPath ||
    join(dirname(resolvePath(args.walletPath)), "staking-collector-mainnet.json");
  let collectorKeypair;
  if (existsSync(collectorPath)) {
    collectorKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(collectorPath, "utf8"))));
    console.log(`collector keypair: reusing ${collectorKeypair.publicKey.toBase58()}`);
  } else {
    collectorKeypair = Keypair.generate();
    mkdirSync(dirname(collectorPath), { recursive: true });
    writeFileSync(collectorPath, JSON.stringify(Array.from(collectorKeypair.secretKey)));
    console.log(`collector keypair: generated ${collectorKeypair.publicKey.toBase58()} → ${collectorPath}`);
  }
  const collector = collectorKeypair.publicKey;
  const collectorInfo = await connection.getAccountInfo(collector);
  if (collectorInfo) {
    console.log("collector token account: already exists — skipping create.");
  } else {
    const rent = await getMinimumBalanceForRentExemptAccount(connection);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: collector,
        space: ACCOUNT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(collector, mint, relayer),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet, collectorKeypair]);
    console.log(`collector token account created: ${collector.toBase58()} (tx ${sig})`);
  }

  // ── 5. Record deployments ──────────────────────────────────────────────
  deployments.cluster = deployments.cluster || "mainnet-beta";
  deployments.rpc = rpc;
  deployments.naveMint = mint.toBase58();
  deployments.programs = {
    ...(deployments.programs || {}),
    nave_bridge: BRIDGE_PROGRAM_ID.toBase58(),
    nave_staking: STAKING_PROGRAM_ID.toBase58(),
  };
  deployments.bridgeV2 = {
    description:
      "Hardened bridge: 2.5% on-top fee split 1%/1%/0.5%, caps + pause + replay; staking leg → relayer-owned collector.",
    bridgeProgram: BRIDGE_PROGRAM_ID.toBase58(),
    stakingProgram: STAKING_PROGRAM_ID.toBase58(),
    bridgeConfig: bridgeConfig.toBase58(),
    custody: custody.toBase58(),
    custodyAuthority: custodyAuthority.toBase58(),
    stakePool: stakePool.toBase58(),
    poolAuthority: poolAuthority.toBase58(),
    stakeVault: stakeVault.toBase58(),
    rewardVault: rewardVault.toBase58(),
    protocolWallet: protocolWallet.toBase58(),
    protocolFeeAccount: protocolFeeAta.toBase58(),
    stakingCollector: collector.toBase58(),
    stakingPoolOwner: relayer.toBase58(),
    owner: owner.toBase58(),
    relayer: relayer.toBase58(),
    feeBps: FEE_BPS,
    stakingBps: STAKING_BPS,
    protocolBps: PROTOCOL_BPS,
    burnBps: BURN_BPS,
    perTxCap: args.perTxCap.toString(),
    dailyCap: args.dailyCap.toString(),
    lockDailyCap: (args.lockDailyCap ?? args.dailyCap).toString(),
    destChains: destChains.map((id) => id.toString()),
    initializedAt: new Date().toISOString(),
  };
  writeFileSync(args.deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
  console.log(`wrote ${args.deploymentsPath} (programs + bridgeV2).`);

  console.log("\nApp / signer wiring:");
  console.log(`  VITE_NAVE_BRIDGE_PROGRAM_ID=${BRIDGE_PROGRAM_ID.toBase58()}`);
  console.log(`  VITE_NAVE_STAKING_PROGRAM_ID=${STAKING_PROGRAM_ID.toBase58()}`);
  console.log(`  VITE_NAVE_BRIDGE_SOLANA_CUSTODY=${custody.toBase58()}`);
  console.log(`  VITE_NAVE_BRIDGE_PROTOCOL_FEE_ACCOUNT=${protocolFeeAta.toBase58()}`);
  console.log(`  VITE_NAVE_BRIDGE_STAKING_POOL_ACCOUNT=${collector.toBase58()}`);
  console.log(`  BRIDGE_SOLANA_PROTOCOL_FEE_ACCOUNT=${protocolFeeAta.toBase58()}`);
  console.log(`  BRIDGE_SOLANA_STAKING_COLLECTOR=${collector.toBase58()}`);
  console.log(`  BRIDGE_SOLANA_STAKING_POOL_ACCOUNT=${collector.toBase58()}`);
  console.log(`  BRIDGE_SOLANA_RELAYER_PUBKEY=${relayer.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
