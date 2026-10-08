/**
 * Standalone Kamino Lend (klend) real-CPI end-to-end on devnet.
 *
 * Proves the deployed nave_core `kamino_deposit` / `kamino_withdraw`
 * instructions perform real `refresh_reserve` + `deposit_reserve_liquidity` /
 * `redeem_reserve_collateral` CPIs into a klend reserve WE created/control on
 * devnet (market 5tnQ8K..., wSOL reserve Ax27Gp...), with the vault_authority
 * PDA signing and cTokens landing in a vault-owned position token account.
 *
 * The reserve uses a CRANKABLE persistent Pyth pull oracle
 * (7UVimff..., shard-0 SOL/USD) that we refresh via tools/pyth-poster before
 * each CPI so klend's staleness check passes. Scope/Switchboard/TWAP disabled.
 *
 * Flow:
 *   1. ensure global config + create a fresh DAO (founder = deploy wallet,
 *      agents[3] = Operational).
 *   2. register wSOL as a SolLike treasury asset.
 *   3. init kamino strategy position + escrow (wSOL); configure targets to our
 *      reserve (ext_market = lending_market, ext_reserve = reserve,
 *      position_token_account holds cTokens of reserve_collateral_mint).
 *   4. fund the wSOL escrow directly (system transfer + sync_native).
 *   5. crank oracle; kamino_deposit -> refresh_reserve + deposit_reserve_liquidity
 *      -> cTokens into the position account.
 *   6. crank oracle; kamino_withdraw -> refresh_reserve + redeem_reserve_collateral
 *      -> underlying wSOL back into the escrow.
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/kamino-cpi-devnet.ts
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
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createDevnetProvider } from "./helpers/devnet-connection";

// ── klend devnet infra (our own market + reserve) ────────────────────────────
const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const LENDING_MARKET = new PublicKey("5tnQ8KnY95VUQHNJs4iM1G6vztTKZXESF1zHbLgg3x4B");
const RESERVE = new PublicKey("Ax27GpkCCQbG8GBLn1cLcZ9uq6rLhHaui68KfoE1YvcF");
const LENDING_MARKET_AUTHORITY = new PublicKey("AjwHyobnT2wRpTwBCHJsBqvTWS1zqFidbRBwUvpxcS2");
const RESERVE_LIQUIDITY_SUPPLY = new PublicKey("C9sNSBA8LCz8Hsw84noG7Zoyn4rESfmR33Tt6SQo1MJz");
const RESERVE_COLLATERAL_MINT = new PublicKey("6CyQ8GTFjz4TN7ViLpMEVivAaqWZRTNfMcKxa8Uizcws");
const PYTH_ORACLE = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PROTOCOL_ID = "kamino";

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

function crankOracle(walletPath: string, rpc: string) {
  const poster = path.resolve(__dirname, "../tools/pyth-poster/post-persistent.mjs");
  const out = execFileSync("node", [poster, "0x" + SOL_USD_FEED_HEX], {
    env: { ...process.env, WALLET: walletPath, RPC: rpc, SHARD: "0" },
    encoding: "utf-8",
  });
  console.log("  oracle cranked:", out.trim());
}

async function main() {
  const rpc = process.env.RPC || "https://api.devnet.solana.com";

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

  console.log("RPC          :", rpc);
  console.log("Founder      :", founder.publicKey.toBase58());
  console.log("nave_core    :", CORE.toBase58());
  console.log("klend market :", LENDING_MARKET.toBase58());
  console.log("klend reserve:", RESERVE.toBase58());

  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const operational = agents[3];
  const guardian = Keypair.generate();

  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: operational.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
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
    name: "kamino-cpi-e2e",
    guardianWallets: [guardian.publicKey],
    guardianThreshold: 1,
    agentAuthorities: agents.map((a) => a.publicKey),
    managementFeeBps: 100,
    performanceFeeBps: 200,
    frozenManagementFeeBps: 50,
    frozenPerformanceFeeBps: 100,
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
      protocolTreasury: founder.publicKey,
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

  console.log("Configure position targets -> klend reserve…");
  await program.methods
    .configurePositionTargets(PROTOCOL_ID, LENDING_MARKET, RESERVE)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: NATIVE_MINT,
      collateralMint: RESERVE_COLLATERAL_MINT,
      vaultAuthority,
      strategyPosition,
      positionTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  // ── fund the wSOL escrow directly ───────────────────────────────────────────
  const fundLamports = 0.05 * LAMPORTS_PER_SOL;
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

  // refresh_reserve oracle slots: [pyth, switchboardPrice, switchboardTwap, scope].
  // Only pyth is configured; the rest are the klend program id placeholder.
  const oracleRemaining = [
    { pubkey: PYTH_ORACLE, isWritable: false, isSigner: false },
    { pubkey: KLEND_PROGRAM, isWritable: false, isSigner: false },
    { pubkey: KLEND_PROGRAM, isWritable: false, isSigner: false },
    { pubkey: KLEND_PROGRAM, isWritable: false, isSigner: false },
  ];

  // ── kamino_deposit (real refresh_reserve + deposit_reserve_liquidity CPI) ────
  console.log("Cranking oracle before deposit…");
  crankOracle(walletPath, rpc);

  const depositAmount = new anchor.BN(0.03 * LAMPORTS_PER_SOL);
  console.log(`kamino_deposit ${depositAmount.toNumber() / LAMPORTS_PER_SOL} wSOL -> deposit_reserve_liquidity CPI…`);
  const depSig = await program.methods
    .kaminoDeposit(depositAmount)
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
      klendProgram: KLEND_PROGRAM,
      reserve: RESERVE,
      lendingMarket: LENDING_MARKET,
      lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
      reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
      reserveCollateralMint: RESERVE_COLLATERAL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
    } as any)
    .remainingAccounts(oracleRemaining)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([operational])
    .rpc();
  console.log("  deposit sig:", depSig);

  const ctokenAfterDep = await getAccount(connection, positionTokenAccount);
  const escrowAfterDep = await getAccount(connection, strategyEscrow);
  console.log("  cTokens received:", ctokenAfterDep.amount.toString());
  console.log("  escrow wSOL after deposit:", escrowAfterDep.amount.toString());
  if (ctokenAfterDep.amount === 0n) throw new Error("deposit_reserve_liquidity produced no cTokens");

  // ── kamino_withdraw (real refresh_reserve + redeem_reserve_collateral CPI) ───
  console.log("Cranking oracle before withdraw…");
  crankOracle(walletPath, rpc);

  const cTokens = new anchor.BN(ctokenAfterDep.amount.toString());
  console.log(`kamino_withdraw ${cTokens.toString()} cTokens -> redeem_reserve_collateral CPI…`);
  const wdSig = await program.methods
    .kaminoWithdraw(cTokens)
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
      klendProgram: KLEND_PROGRAM,
      reserve: RESERVE,
      lendingMarket: LENDING_MARKET,
      lendingMarketAuthority: LENDING_MARKET_AUTHORITY,
      reserveLiquiditySupply: RESERVE_LIQUIDITY_SUPPLY,
      reserveCollateralMint: RESERVE_COLLATERAL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
    } as any)
    .remainingAccounts(oracleRemaining)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([operational])
    .rpc();
  console.log("  withdraw sig:", wdSig);

  const ctokenAfterWd = await getAccount(connection, positionTokenAccount);
  const escrowAfter = await getAccount(connection, strategyEscrow);
  console.log("  cTokens remaining:", ctokenAfterWd.amount.toString());
  console.log("  escrow wSOL after withdraw:", escrowAfter.amount.toString());

  console.log("\n=== KAMINO REAL-CPI E2E PASSED ===");
  console.log("DAO              :", daoRegistry.toBase58());
  console.log("market / reserve :", LENDING_MARKET.toBase58(), "/", RESERVE.toBase58());
  console.log("position(cToken) :", positionTokenAccount.toBase58());
  console.log("deposit sig      :", depSig);
  console.log("withdraw sig     :", wdSig);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("E2E FAILED:", e);
    if (e?.logs) console.error("LOGS:\n" + e.logs.join("\n"));
    process.exit(1);
  }
);
