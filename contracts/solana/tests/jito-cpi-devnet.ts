/**
 * Standalone, oracle-free Jito (SPL stake-pool) real-CPI end-to-end on devnet.
 *
 * Proves the deployed nave_core `jito_deposit` / `jito_withdraw` instructions
 * perform real `DepositSol` / `WithdrawSol` CPIs into a live, maintained SPL
 * stake pool (BlazeStake bSOL), with the vault_authority PDA signing and pool
 * tokens (bSOL) landing in a vault-owned position token account.
 *
 * Flow:
 *   1. ensure global config + create a fresh DAO (founder = deploy wallet,
 *      agents[3] = Operational).
 *   2. register wSOL as a SolLike treasury asset.
 *   3. init jito strategy position + escrow (wSOL) and configure targets to the
 *      BlazeStake pool (ext_market = stake_pool, ext_reserve = reserve_stake,
 *      position_token_account holds bSOL).
 *   4. fund the wSOL escrow directly (system transfer + sync_native) — no
 *      execution/oracle path needed.
 *   5. jito_deposit -> real DepositSol -> bSOL into the position account.
 *   6. jito_withdraw -> real WithdrawSol -> lamports re-wrapped into the escrow.
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   ../node_modules/.bin/ts-node tests/jito-cpi-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createDevnetProvider } from "./helpers/devnet-connection";

// ── deployed external infra (devnet) ─────────────────────────────────────────
const SPL_STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
// BlazeStake bSOL pool (live, permissionless, updated current epoch).
const STAKE_POOL = new PublicKey("azFVdHtAJN8BX3sbGAYkXvtdjdrT5U6rj9rovvUFos9");
const RESERVE_STAKE = new PublicKey("aRkys1kVHeysrcn9bJFat9FkvoyyYD8M1kK286X3Aro");
const POOL_MINT = new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"); // bSOL
const MANAGER_FEE_ACCOUNT = new PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1");

// SOL/USD Pyth pull-oracle feed id (not exercised by the CPI; stored on the asset).
const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PROTOCOL_ID = "jito";

function feedHexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  if (out.length !== 32) throw new Error(`feed id must be 32 bytes, got ${out.length}`);
  return out;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Fill unset vars from the gitignored local env. Never overrides the process. */
function loadLocalEnv() {
  const envPath = path.resolve(__dirname, "../.env.testnet.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function redactRpc(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…`;
  } catch {
    return "(configured)";
  }
}

async function main() {
  loadLocalEnv();
  const rpc = process.env.RPC || process.env.SOLANA_DEVNET_RPC || "https://api.devnet.solana.com";

  const walletPath = path.resolve(__dirname, "../.deploy-wallet-devnet.json");
  const founder = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const provider = createDevnetProvider(founder, rpc);
  const connection = provider.connection;
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../target/idl/nave_core.json"), "utf-8")
  );
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const CORE = program.programId;

  console.log("RPC          :", redactRpc(rpc));
  console.log("Founder      :", founder.publicKey.toBase58());
  console.log("nave_core    :", CORE.toBase58());

  // ── agents: index 3 = Operational ──────────────────────────────────────────
  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const operational = agents[3];
  const guardian = Keypair.generate();

  // Fund the operational agent (pays temp_wsol rent + tx fees in jito_deposit).
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: operational.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    )
  );

  // ── global config ───────────────────────────────────────────────────────────
  const globalConfig = pda([Buffer.from("global_config")], CORE);
  const gcInfo = await connection.getAccountInfo(globalConfig);
  if (!gcInfo) {
    console.log("Initializing global config…");
    await program.methods
      .initializeGlobalConfig(new anchor.BN(2 * LAMPORTS_PER_SOL))
      .accounts({
        authority: founder.publicKey,
        globalConfig,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }
  const global = await (program.account as any).naveGlobalConfig.fetch(globalConfig);
  const daoId: anchor.BN = global.daoCount;
  console.log("DAO id       :", daoId.toString());

  // ── DAO PDAs ────────────────────────────────────────────────────────────────
  const daoRegistry = pda(
    [Buffer.from("dao"), founder.publicKey.toBuffer(), daoId.toArrayLike(Buffer, "le", 8)],
    CORE
  );
  const vaultAuthority = pda([Buffer.from("vault_authority"), daoRegistry.toBuffer()], CORE);
  const treasuryVault = pda([Buffer.from("treasury_vault"), daoRegistry.toBuffer()], CORE);
  const agentSet = pda([Buffer.from("agent_set"), daoRegistry.toBuffer()], CORE);
  const feeConfig = pda([Buffer.from("fee_config"), daoRegistry.toBuffer()], CORE);
  const guardianConfig = pda([Buffer.from("guardian_config"), daoRegistry.toBuffer()], CORE);
  const constitution = pda([Buffer.from("constitution"), daoRegistry.toBuffer()], CORE);
  const tokenRegistry = pda([Buffer.from("token_registry"), daoRegistry.toBuffer()], CORE);

  const vaultMint = await createMint(connection, founder, founder.publicKey, null, 6);
  const feeRecipientAta = getAssociatedTokenAddressSync(vaultMint, founder.publicKey);

  const params = {
    name: "jito-cpi-e2e",
    guardianWallets: [guardian.publicKey],
    guardianThreshold: 1,
    agentAuthorities: agents.map((a) => a.publicKey),
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
    privacyMode: 0,
    feeRecipient: feeRecipientAta,
    // Audit ABI: initialize_dao now requires a non-default protocol revenue
    // wallet (receives the performance skim + annual management fee).
    protocolRevenueWallet: founder.publicKey,
    quorumBps: 1000,
    governanceType: 1,
  };

  console.log("DAO registry :", daoRegistry.toBase58());
  console.log("Creating DAO…");
  await program.methods
    .initializeDao(params as any)
    .accounts({
      founder: founder.publicKey,
      globalConfig,
      protocolTreasury: global.treasury,
      daoRegistry,
      vaultAuthority,
      treasuryVault,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);
  await program.methods
    .initializeDaoExtensions(params as any)
    .accounts({
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
    } as any)
    .preInstructions([
      createAssociatedTokenAccountInstruction(
        founder.publicKey,
        vaultTokenAccount,
        vaultAuthority,
        vaultMint
      ),
    ])
    .rpc();

  await program.methods
    .initializeDaoGovernance(params as any)
    .accounts({
      founder: founder.publicKey,
      globalConfig,
      daoRegistry,
      guardianConfig,
      constitution,
      tokenRegistry,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  console.log("  DAO created.");

  // ── register wSOL as a SolLike treasury asset ───────────────────────────────
  const assetConfig = pda(
    [Buffer.from("asset_config"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()],
    CORE
  );
  const treasuryAsset = pda(
    [Buffer.from("treasury_asset"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()],
    CORE
  );
  const assetVault = pda(
    [Buffer.from("asset_vault"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()],
    CORE
  );
  console.log("Registering wSOL asset…");
  await program.methods
    .registerAsset(feedHexToBytes(SOL_USD_FEED_HEX), false, 1) // is_stablecoin=false, kind=SolLike
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: NATIVE_MINT,
      vaultAuthority,
      treasuryVault,
      assetConfig,
      treasuryAsset,
      assetVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  // ── strategy position + escrow + targets ────────────────────────────────────
  const pid = Buffer.from(PROTOCOL_ID);
  const strategyPosition = pda(
    [Buffer.from("strategy_position"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()],
    CORE
  );
  const strategyEscrow = pda(
    [Buffer.from("strategy_escrow"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()],
    CORE
  );
  const positionTokenAccount = pda(
    [Buffer.from("position_token"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()],
    CORE
  );
  const solFunding = pda([Buffer.from("sol_funding"), daoRegistry.toBuffer()], CORE);
  const tempWsol = pda(
    [Buffer.from("jito_tmp_wsol"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()],
    CORE
  );
  const stakePoolWithdrawAuthority = pda(
    [STAKE_POOL.toBuffer(), Buffer.from("withdraw")],
    SPL_STAKE_POOL_PROGRAM
  );

  console.log("Init strategy position…");
  await program.methods
    .initStrategyPosition(PROTOCOL_ID)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: NATIVE_MINT,
      strategyPosition,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  console.log("Init strategy escrow…");
  await program.methods
    .initStrategyEscrow(PROTOCOL_ID)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      vaultAuthority,
      treasuryAsset,
      mint: NATIVE_MINT,
      strategyEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  console.log("Configure position targets -> BlazeStake pool…");
  await program.methods
    .configurePositionTargets(PROTOCOL_ID, STAKE_POOL, RESERVE_STAKE)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: NATIVE_MINT,
      collateralMint: POOL_MINT,
      vaultAuthority,
      strategyPosition,
      positionTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  // ── fund the wSOL escrow directly (no execution/oracle path) ────────────────
  const fundLamports = 0.12 * LAMPORTS_PER_SOL;
  console.log(`Funding escrow with ${fundLamports / LAMPORTS_PER_SOL} wSOL…`);
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: strategyEscrow,
        lamports: fundLamports,
      }),
      createSyncNativeInstruction(strategyEscrow)
    )
  );
  const escrowBefore = await getAccount(connection, strategyEscrow);
  console.log("  escrow wSOL:", escrowBefore.amount.toString());

  // ── jito_deposit (real DepositSol CPI) ──────────────────────────────────────
  const depositAmount = new anchor.BN(0.05 * LAMPORTS_PER_SOL);
  console.log(`jito_deposit ${depositAmount.toNumber() / LAMPORTS_PER_SOL} SOL -> DepositSol CPI…`);
  const depSig = await program.methods
    .jitoDeposit(depositAmount)
    .accounts({
      authority: operational.publicKey,
      globalConfig,
      daoRegistry,
      agentSet,
      mint: NATIVE_MINT,
      vaultAuthority,
      strategyPosition,
      strategyEscrow,
      positionTokenAccount,
      solFunding,
      tempWsol,
      stakePoolProgram: SPL_STAKE_POOL_PROGRAM,
      stakePool: STAKE_POOL,
      stakePoolWithdrawAuthority,
      reserveStake: RESERVE_STAKE,
      managerFeeAccount: MANAGER_FEE_ACCOUNT,
      poolMint: POOL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([operational])
    .rpc();
  console.log("  deposit sig:", depSig);

  const bsolAfterDep = await getAccount(connection, positionTokenAccount);
  console.log("  bSOL received:", bsolAfterDep.amount.toString());
  if (bsolAfterDep.amount === 0n) throw new Error("DepositSol produced no bSOL");

  // ── jito_withdraw (real WithdrawSol CPI) ────────────────────────────────────
  const poolTokens = new anchor.BN(bsolAfterDep.amount.toString());
  console.log(`jito_withdraw ${poolTokens.toString()} bSOL -> WithdrawSol CPI…`);
  const wdSig = await program.methods
    .jitoWithdraw(poolTokens)
    .accounts({
      authority: operational.publicKey,
      globalConfig,
      daoRegistry,
      agentSet,
      mint: NATIVE_MINT,
      vaultAuthority,
      strategyPosition,
      strategyEscrow,
      positionTokenAccount,
      solFunding,
      stakePoolProgram: SPL_STAKE_POOL_PROGRAM,
      stakePool: STAKE_POOL,
      stakePoolWithdrawAuthority,
      reserveStake: RESERVE_STAKE,
      managerFeeAccount: MANAGER_FEE_ACCOUNT,
      poolMint: POOL_MINT,
      clock: SYSVAR_CLOCK_PUBKEY,
      stakeHistory: SYSVAR_STAKE_HISTORY_PUBKEY,
      stakeProgram: STAKE_PROGRAM,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([operational])
    .rpc();
  console.log("  withdraw sig:", wdSig);

  const bsolAfterWd = await getAccount(connection, positionTokenAccount);
  const escrowAfter = await getAccount(connection, strategyEscrow);
  console.log("  bSOL remaining:", bsolAfterWd.amount.toString());
  console.log("  escrow wSOL after:", escrowAfter.amount.toString());

  console.log("\n=== JITO REAL-CPI E2E PASSED ===");
  console.log("DAO            :", daoRegistry.toBase58());
  console.log("position(bSOL) :", positionTokenAccount.toBase58());
  console.log("deposit sig    :", depSig);
  console.log("withdraw sig   :", wdSig);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("E2E FAILED:", e);
    if (e?.logs) console.error("LOGS:\n" + e.logs.join("\n"));
    process.exit(1);
  }
);
