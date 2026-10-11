/**
 * Standalone, oracle-free Jupiter Lend (Earn) real-CPI end-to-end on devnet.
 *
 * Proves the deployed nave_core `jupiter_deposit` / `jupiter_withdraw`
 * instructions perform real `deposit` / `withdraw` CPIs into a live Jupiter Lend
 * Earn vault (the maintained devnet wSOL vault), with the vault_authority PDA as
 * the Jupiter `signer` and jlTokens (jlSOL) landing in a vault-owned ATA.
 *
 * Flow:
 *   1. ensure global config + create a fresh DAO (founder = deploy wallet,
 *      agents[3] = Operational).
 *   2. register wSOL as a SolLike treasury asset.
 *   3. init jupiter strategy position + configure targets
 *      (ext_market = lending PDA, ext_reserve = liquidity vault ATA).
 *   4. fund the vault_authority's wSOL ATA directly (system transfer +
 *      sync_native) — no execution/oracle path needed.
 *   5. jupiter_deposit -> real Jupiter `deposit` CPI -> jlSOL into the vault ATA.
 *   6. jupiter_withdraw(u64::MAX) -> real Jupiter `withdraw` CPI -> wSOL back.
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   ../node_modules/.bin/ts-node tests/jupiter-cpi-devnet.ts
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
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createDevnetProvider } from "./helpers/devnet-connection";

// ── Jupiter Lend (Earn) devnet infra ─────────────────────────────────────────
const JUP_LENDING_PROGRAM = new PublicKey("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
const JUP_LIQUIDITY_PROGRAM = new PublicKey("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");

// SOL/USD Pyth pull-oracle feed id (stored on the asset; not exercised by CPI).
const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PROTOCOL_ID = "jupiter";

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
  const asset = NATIVE_MINT; // wSOL

  console.log("RPC          :", rpc);
  console.log("Founder      :", founder.publicKey.toBase58());
  console.log("nave_core    :", CORE.toBase58());

  // ── resolve Jupiter Lend accounts for the wSOL Earn vault ───────────────────
  const B = (s: string) => Buffer.from(s);
  const fTokenMint = pda([B("f_token_mint"), asset.toBuffer()], JUP_LENDING_PROGRAM);
  const lending = pda([B("lending"), asset.toBuffer(), fTokenMint.toBuffer()], JUP_LENDING_PROGRAM);
  const lendingAdmin = pda([B("lending_admin")], JUP_LENDING_PROGRAM);
  const liquidity = pda([B("liquidity")], JUP_LIQUIDITY_PROGRAM);
  const rateModel = pda([B("rate_model"), asset.toBuffer()], JUP_LIQUIDITY_PROGRAM);
  const supplyReserve = pda([B("reserve"), asset.toBuffer()], JUP_LIQUIDITY_PROGRAM);
  const supplyPosition = pda(
    [B("user_supply_position"), asset.toBuffer(), lending.toBuffer()],
    JUP_LIQUIDITY_PROGRAM
  );
  const claimAccount = pda(
    [B("user_claim"), lendingAdmin.toBuffer(), asset.toBuffer()],
    JUP_LIQUIDITY_PROGRAM
  );
  const jupVault = getAssociatedTokenAddressSync(asset, liquidity, true);

  // Authoritative sub-account fields come from the on-chain Lending account.
  const lendingInfo = await connection.getAccountInfo(lending);
  if (!lendingInfo) throw new Error(`Jupiter Lending account ${lending.toBase58()} not found on devnet`);
  const raw = lendingInfo.data;
  const readPk = (off: number) => new PublicKey(raw.subarray(off, off + 32));
  const onchainFToken = readPk(40);
  const rewardsRateModel = readPk(75);
  const onchainReserve = readPk(107 + 24);
  const onchainSupplyPos = readPk(107 + 24 + 32);
  // sanity: derived must match on-chain
  if (!onchainFToken.equals(fTokenMint)) throw new Error("fTokenMint mismatch");
  if (!onchainReserve.equals(supplyReserve)) throw new Error("supplyReserve mismatch");
  if (!onchainSupplyPos.equals(supplyPosition)) throw new Error("supplyPosition mismatch");

  console.log("Jupiter Lend (wSOL Earn vault):");
  console.log("  lending           :", lending.toBase58());
  console.log("  fTokenMint (jlSOL):", fTokenMint.toBase58());
  console.log("  lendingAdmin      :", lendingAdmin.toBase58());
  console.log("  liquidity         :", liquidity.toBase58());
  console.log("  rateModel         :", rateModel.toBase58());
  console.log("  supplyReserve     :", supplyReserve.toBase58());
  console.log("  supplyPosition    :", supplyPosition.toBase58());
  console.log("  rewardsRateModel  :", rewardsRateModel.toBase58());
  console.log("  claimAccount      :", claimAccount.toBase58());
  console.log("  vault (ATA)       :", jupVault.toBase58());

  // ── agents: index 3 = Operational ──────────────────────────────────────────
  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const operational = agents[3];
  const guardian = Keypair.generate();

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
    name: "jupiter-cpi-e2e",
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
  const assetConfig = pda([Buffer.from("asset_config"), daoRegistry.toBuffer(), asset.toBuffer()], CORE);
  const treasuryAsset = pda([Buffer.from("treasury_asset"), daoRegistry.toBuffer(), asset.toBuffer()], CORE);
  const assetVault = pda([Buffer.from("asset_vault"), daoRegistry.toBuffer(), asset.toBuffer()], CORE);
  console.log("Registering wSOL asset…");
  await program.methods
    .registerAsset(feedHexToBytes(SOL_USD_FEED_HEX), false, 1)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: asset,
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

  // ── strategy position + targets ─────────────────────────────────────────────
  const pid = Buffer.from(PROTOCOL_ID);
  const strategyPosition = pda(
    [Buffer.from("strategy_position"), daoRegistry.toBuffer(), pid, asset.toBuffer()],
    CORE
  );
  const positionTokenAccount = pda(
    [Buffer.from("position_token"), daoRegistry.toBuffer(), pid, asset.toBuffer()],
    CORE
  );

  console.log("Init strategy position…");
  await program.methods
    .initStrategyPosition(PROTOCOL_ID)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: asset,
      strategyPosition,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  // Bind targets: ext_market = Jupiter lending PDA, ext_reserve = liquidity vault.
  // (The PDA position_token_account of jlSOL created here is unused by the CPI;
  // the CPI uses the vault_authority's jlSOL ATA. It is a harmless binding step.)
  console.log("Configure position targets -> Jupiter wSOL vault…");
  await program.methods
    .configurePositionTargets(PROTOCOL_ID, lending, jupVault)
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      mint: asset,
      collateralMint: fTokenMint,
      vaultAuthority,
      strategyPosition,
      positionTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  // ── fund the vault_authority's wSOL ATA (deposit source) ────────────────────
  const vaultWsolAta = getAssociatedTokenAddressSync(asset, vaultAuthority, true);
  const vaultJlAta = getAssociatedTokenAddressSync(fTokenMint, vaultAuthority, true);
  const fundLamports = 0.05 * LAMPORTS_PER_SOL;
  console.log(`Funding vault wSOL ATA with ${fundLamports / LAMPORTS_PER_SOL} wSOL…`);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        founder.publicKey,
        vaultWsolAta,
        vaultAuthority,
        asset
      ),
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: vaultWsolAta,
        lamports: fundLamports,
      }),
      createSyncNativeInstruction(vaultWsolAta)
    )
  );
  const srcBefore = await getAccount(connection, vaultWsolAta);
  console.log("  vault wSOL:", srcBefore.amount.toString());

  // ── jupiter_deposit (real Jupiter deposit CPI) ──────────────────────────────
  const depositAmount = new anchor.BN(0.03 * LAMPORTS_PER_SOL);
  const jupAccounts = {
    authority: operational.publicKey,
    globalConfig,
    daoRegistry,
    agentSet,
    mint: asset,
    fTokenMint,
    vaultAuthority,
    strategyPosition,
    depositorTokenAccount: vaultWsolAta,
    recipientTokenAccount: vaultJlAta,
    jupiterLendingProgram: JUP_LENDING_PROGRAM,
    lendingAdmin,
    lending,
    supplyTokenReservesLiquidity: supplyReserve,
    lendingSupplyPositionOnLiquidity: supplyPosition,
    rateModel,
    vault: jupVault,
    liquidity,
    liquidityProgram: JUP_LIQUIDITY_PROGRAM,
    rewardsRateModel,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };

  console.log(`jupiter_deposit ${depositAmount.toNumber() / LAMPORTS_PER_SOL} wSOL -> deposit CPI…`);
  const depSig = await program.methods
    .jupiterDeposit(depositAmount)
    .accounts(jupAccounts as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([operational])
    .rpc();
  console.log("  deposit sig:", depSig);

  const jlAfterDep = await getAccount(connection, vaultJlAta);
  console.log("  jlSOL received:", jlAfterDep.amount.toString());
  if (jlAfterDep.amount === 0n) throw new Error("Jupiter deposit produced no jlSOL");

  // ── jupiter_withdraw (real Jupiter withdraw CPI, full position) ─────────────
  const U64_MAX = new anchor.BN("18446744073709551615");
  console.log("jupiter_withdraw u64::MAX (full) -> withdraw CPI…");
  const wdSig = await program.methods
    .jupiterWithdraw(U64_MAX)
    .accounts({
      ...jupAccounts,
      ownerTokenAccount: vaultJlAta,
      recipientTokenAccount: vaultWsolAta,
      claimAccount,
    } as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .signers([operational])
    .rpc();
  console.log("  withdraw sig:", wdSig);

  const jlAfterWd = await getAccount(connection, vaultJlAta);
  const srcAfter = await getAccount(connection, vaultWsolAta);
  console.log("  jlSOL remaining   :", jlAfterWd.amount.toString());
  console.log("  vault wSOL after  :", srcAfter.amount.toString());

  console.log("\n=== JUPITER LEND REAL-CPI E2E PASSED ===");
  console.log("DAO              :", daoRegistry.toBase58());
  console.log("vault jlSOL ATA  :", vaultJlAta.toBase58());
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
