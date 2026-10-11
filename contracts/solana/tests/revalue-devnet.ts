/**
 * Standalone on-chain USD NAV e2e on devnet via Pyth pull oracle.
 *
 * Proves the deployed nave_core `revalue_treasury` prices a multi-asset treasury
 * in USD from a freshly-posted Pyth `PriceUpdateV2`:
 *   1. create a fresh DAO (founder = deploy wallet).
 *   2. register wSOL as a SolLike asset (SOL/USD feed).
 *   3. deposit wSOL into the asset vault.
 *   4. post a SOL/USD PriceUpdateV2 to devnet (Hermes + pyth-solana-receiver).
 *   5. revalue_treasury([AssetConfig, TreasuryAsset, asset_vault, PriceUpdateV2])
 *      -> treasury_vault.current_nav (micro-USD) and verify it matches
 *      deposited_SOL * Pyth price.
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   ../node_modules/.bin/ts-node tests/revalue-devnet.ts
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
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
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createDevnetProvider } from "./helpers/devnet-connection";

/** Post a fresh PriceUpdateV2 via the isolated poster (clean dep tree). */
function postPriceUpdate(feed: string, walletPath: string, rpc: string): PublicKey {
  const out = execFileSync("node", ["tools/pyth-poster/post.mjs", feed], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, WALLET: walletPath, RPC: rpc },
    encoding: "utf-8",
  });
  const line = out.split("\n").find((l) => l.startsWith("PRICE_UPDATE_ACCOUNT="));
  if (!line) throw new Error("poster did not return a price update account:\n" + out);
  return new PublicKey(line.trim().split(":")[1]);
}

/** Latest SOL/USD price from Hermes REST (no SDK; for NAV verification only). */
async function hermesPrice(feed: string): Promise<{ price: number; expo: number }> {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feed.replace(/^0x/, "")}&parsed=true&encoding=base64`;
  const res = await fetch(url);
  const json: any = await res.json();
  const p = json.parsed[0].price;
  return { price: Number(p.price), expo: Number(p.expo) };
}

const SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

function feedHexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
const pda = (seeds: (Buffer | Uint8Array)[], p: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, p)[0];

async function main() {
  const rpc = process.env.RPC || "https://api.devnet.solana.com";
  const founder = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.resolve(__dirname, "../.deploy-wallet-devnet.json"), "utf-8"))
    )
  );
  const provider = createDevnetProvider(founder, rpc);
  const connection = provider.connection;
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../target/idl/nave_core.json"), "utf-8")
  );
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const CORE = program.programId;
  console.log("Founder   :", founder.publicKey.toBase58());
  console.log("nave_core :", CORE.toBase58());

  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const guardian = Keypair.generate();

  // ── global config + fresh DAO ───────────────────────────────────────────────
  const globalConfig = pda([Buffer.from("global_config")], CORE);
  const global = await (program.account as any).naveGlobalConfig.fetch(globalConfig);
  const daoId: anchor.BN = global.daoCount;
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
    name: "revalue-e2e",
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
  console.log("DAO id    :", daoId.toString(), "registry:", daoRegistry.toBase58());
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

  // ── register wSOL + deposit into the asset vault ────────────────────────────
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
    .registerAsset(feedHexToBytes(SOL_USD_FEED), false, 1)
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

  const depositSol = 0.1;
  const depositBase = Math.floor(depositSol * LAMPORTS_PER_SOL);
  const founderWsol = getAssociatedTokenAddressSync(NATIVE_MINT, founder.publicKey);
  console.log(`Wrapping + depositing ${depositSol} wSOL into asset vault…`);
  await provider.sendAndConfirm(
    new Transaction().add(
      // Idempotent: the founder's wSOL ATA may already exist from a prior
      // devnet run (state persists across runs); a non-idempotent create is
      // rejected by the ATA program ("Provided owner is not allowed").
      createAssociatedTokenAccountIdempotentInstruction(
        founder.publicKey,
        founderWsol,
        founder.publicKey,
        NATIVE_MINT
      ),
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: founderWsol,
        lamports: depositBase + Math.floor(0.01 * LAMPORTS_PER_SOL),
      }),
      createSyncNativeInstruction(founderWsol)
    )
  );
  await program.methods
    .depositToAsset(new anchor.BN(depositBase))
    .accounts({
      depositor: founder.publicKey,
      daoRegistry,
      mint: NATIVE_MINT,
      assetConfig,
      treasuryAsset,
      assetVault,
      depositorTokenAccount: founderWsol,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
  const av = await getAccount(connection, assetVault);
  console.log("  asset vault wSOL:", av.amount.toString());

  // ── post a fresh SOL/USD PriceUpdateV2 (isolated poster) ────────────────────
  console.log("Posting fresh SOL/USD PriceUpdateV2 to devnet…");
  const walletPath = path.resolve(__dirname, "../.deploy-wallet-devnet.json");
  const priceUpdateAccount = postPriceUpdate(SOL_USD_FEED, walletPath, rpc);
  const price = await hermesPrice(SOL_USD_FEED);
  console.log(`  SOL/USD = ${price.price * 10 ** price.expo} (price=${price.price}, expo=${price.expo})`);
  const puInfo = await connection.getAccountInfo(priceUpdateAccount);
  console.log("  PriceUpdateV2:", priceUpdateAccount.toBase58(), "owner:", puInfo?.owner.toBase58(), "len:", puInfo?.data.length);

  // ── revalue_treasury ────────────────────────────────────────────────────────
  console.log("revalue_treasury…");
  await program.methods
    .revalueTreasury()
    .accounts({
      authority: founder.publicKey,
      globalConfig,
      daoRegistry,
      agentSet,
      treasuryVault,
    } as any)
    .remainingAccounts([
      { pubkey: assetConfig, isSigner: false, isWritable: false },
      { pubkey: treasuryAsset, isSigner: false, isWritable: true },
      { pubkey: assetVault, isSigner: false, isWritable: false },
      { pubkey: priceUpdateAccount, isSigner: false, isWritable: false },
    ])
    .rpc();

  const vault = await (program.account as any).treasuryVault.fetch(treasuryVault);
  const navUsd = Number(vault.currentNav) / 1e6;
  const expectedUsd = depositSol * (Number(price.price) * 10 ** price.expo);
  console.log("\n=== ON-CHAIN USD NAV (Pyth) ===");
  console.log("current_nav (micro-USD):", vault.currentNav.toString());
  console.log("NAV $:", navUsd.toFixed(4));
  console.log("expected $:", expectedUsd.toFixed(4));
  console.log("high_water_mark:", vault.highWaterMark.toString());
  const driftPct = Math.abs(navUsd - expectedUsd) / expectedUsd * 100;
  console.log("drift %:", driftPct.toFixed(3));
  if (driftPct > 1) throw new Error(`NAV drift too high: ${driftPct}%`);
  console.log("\n=== REVALUE_TREASURY USD-NAV E2E PASSED ===");
  console.log("DAO            :", daoRegistry.toBase58());
  console.log("PriceUpdateV2  :", priceUpdateAccount.toBase58());
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("E2E FAILED:", e);
    if (e?.logs) console.error("LOGS:\n" + e.logs.join("\n"));
    process.exit(1);
  }
);
