/**
 * Multi-asset USD NAV e2e on devnet: one DAO holding BOTH a stablecoin (mock
 * USDC, valued at $1 on-chain) AND wSOL (valued via Pyth), aggregated into a
 * single portfolio NAV by `revalue_treasury`.
 *
 * Proves "a DAO can hold any kind of token (SOL, wSOL, USDC, …)" with a unified
 * on-chain USD valuation: NAV = USDC_units*$1 + wSOL_units*SOL/USD.
 *
 * Run:
 *   RPC=https://api.devnet.solana.com \
 *   ../node_modules/.bin/ts-node tests/revalue-multiasset-devnet.ts
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
  mintTo,
  getOrCreateAssociatedTokenAccount,
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

const SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const ZERO_FEED = new Array(32).fill(0);

function feedHexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
const pda = (seeds: (Buffer | Uint8Array)[], p: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, p)[0];

function postPriceUpdate(feed: string, walletPath: string, rpc: string): PublicKey {
  const out = execFileSync("node", ["tools/pyth-poster/post.mjs", feed], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, WALLET: walletPath, RPC: rpc },
    encoding: "utf-8",
  });
  const line = out.split("\n").find((l) => l.startsWith("PRICE_UPDATE_ACCOUNT="));
  if (!line) throw new Error("poster returned no account:\n" + out);
  return new PublicKey(line.trim().split(":")[1]);
}
async function hermesPrice(feed: string): Promise<{ price: number; expo: number }> {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feed.replace(/^0x/, "")}&parsed=true&encoding=base64`;
  const j: any = await (await fetch(url)).json();
  const p = j.parsed[0].price;
  return { price: Number(p.price), expo: Number(p.expo) };
}

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

  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const guardian = Keypair.generate();
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
    name: "multiasset-e2e",
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
      createAssociatedTokenAccountInstruction(founder.publicKey, vaultTokenAccount, vaultAuthority, vaultMint),
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

  // helper to register + deposit an asset
  async function registerAndDeposit(
    mint: PublicKey,
    feedBytes: number[],
    isStable: boolean,
    kind: number,
    depositBase: number,
    depositorAta: PublicKey
  ) {
    const assetConfig = pda([Buffer.from("asset_config"), daoRegistry.toBuffer(), mint.toBuffer()], CORE);
    const treasuryAsset = pda([Buffer.from("treasury_asset"), daoRegistry.toBuffer(), mint.toBuffer()], CORE);
    const assetVault = pda([Buffer.from("asset_vault"), daoRegistry.toBuffer(), mint.toBuffer()], CORE);
    await program.methods
      .registerAsset(feedBytes, isStable, kind)
      .accounts({
        authority: founder.publicKey,
        globalConfig,
        daoRegistry,
        mint,
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
    await program.methods
      .depositToAsset(new anchor.BN(depositBase))
      .accounts({
        depositor: founder.publicKey,
        daoRegistry,
        mint,
        assetConfig,
        treasuryAsset,
        assetVault,
        depositorTokenAccount: depositorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    return { assetConfig, treasuryAsset, assetVault };
  }

  // ── mock USDC (stablecoin) ──────────────────────────────────────────────────
  console.log("Creating mock USDC + registering as stablecoin…");
  const usdcMint = await createMint(connection, founder, founder.publicKey, null, 6);
  const founderUsdc = (
    await getOrCreateAssociatedTokenAccount(connection, founder, usdcMint, founder.publicKey)
  ).address;
  const usdcUnits = 250 * 1_000_000; // 250 USDC
  await mintTo(connection, founder, usdcMint, founderUsdc, founder, usdcUnits);
  const usdc = await registerAndDeposit(usdcMint, ZERO_FEED, true, 0, usdcUnits, founderUsdc);
  console.log("  deposited 250 USDC");

  // ── wSOL (SolLike) ──────────────────────────────────────────────────────────
  console.log("Wrapping + registering wSOL…");
  const founderWsol = getAssociatedTokenAddressSync(NATIVE_MINT, founder.publicKey);
  const wsolBase = Math.floor(0.2 * LAMPORTS_PER_SOL);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(founder.publicKey, founderWsol, founder.publicKey, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: founderWsol,
        lamports: wsolBase + Math.floor(0.01 * LAMPORTS_PER_SOL),
      }),
      createSyncNativeInstruction(founderWsol)
    )
  );
  const wsol = await registerAndDeposit(NATIVE_MINT, feedHexToBytes(SOL_USD_FEED), false, 1, wsolBase, founderWsol);
  console.log("  deposited 0.2 wSOL");

  // ── post SOL price + revalue both assets ────────────────────────────────────
  console.log("Posting SOL/USD PriceUpdateV2…");
  const walletPath = path.resolve(__dirname, "../.deploy-wallet-devnet.json");
  const priceUpdate = postPriceUpdate(SOL_USD_FEED, walletPath, rpc);
  const price = await hermesPrice(SOL_USD_FEED);
  const solUsd = price.price * 10 ** price.expo;
  console.log("  SOL/USD =", solUsd);

  console.log("revalue_treasury (USDC stable + wSOL via Pyth)…");
  await program.methods
    .revalueTreasury()
    .accounts({ authority: founder.publicKey, globalConfig, daoRegistry, agentSet, treasuryVault } as any)
    .remainingAccounts([
      // USDC group — stablecoin; 4th slot is a placeholder (asset_vault reused).
      { pubkey: usdc.assetConfig, isSigner: false, isWritable: false },
      { pubkey: usdc.treasuryAsset, isSigner: false, isWritable: true },
      { pubkey: usdc.assetVault, isSigner: false, isWritable: false },
      { pubkey: usdc.assetVault, isSigner: false, isWritable: false },
      // wSOL group — priced via the posted PriceUpdateV2.
      { pubkey: wsol.assetConfig, isSigner: false, isWritable: false },
      { pubkey: wsol.treasuryAsset, isSigner: false, isWritable: true },
      { pubkey: wsol.assetVault, isSigner: false, isWritable: false },
      { pubkey: priceUpdate, isSigner: false, isWritable: false },
    ])
    .rpc();

  const vault = await (program.account as any).treasuryVault.fetch(treasuryVault);
  const navUsd = Number(vault.currentNav) / 1e6;
  const expectedUsd = 250 * 1.0 + 0.2 * solUsd;
  const driftPct = (Math.abs(navUsd - expectedUsd) / expectedUsd) * 100;
  console.log("\n=== MULTI-ASSET USD NAV ===");
  console.log("USDC value $:", (250).toFixed(2));
  console.log("wSOL  value $:", (0.2 * solUsd).toFixed(4));
  console.log("current_nav $:", navUsd.toFixed(4));
  console.log("expected   $:", expectedUsd.toFixed(4));
  console.log("drift %     :", driftPct.toFixed(3));
  if (driftPct > 1) throw new Error(`NAV drift too high: ${driftPct}%`);
  console.log("\n=== MULTI-ASSET REVALUE E2E PASSED ===");
  console.log("DAO          :", daoRegistry.toBase58());
  console.log("USDC mint    :", usdcMint.toBase58());
  console.log("PriceUpdateV2:", priceUpdate.toBase58());
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("E2E FAILED:", e);
    if (e?.logs) console.error("LOGS:\n" + e.logs.join("\n"));
    process.exit(1);
  }
);
