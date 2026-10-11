/**
 * Devnet round trip with three guardian wallets.
 * One yes vote must not finalize. Two yes votes pass, then BlazeStake
 * deposit and withdraw run on the same treasury. Every signer other than the
 * Operational agent is refused on both venue legs, and a 2-of-3 guardian
 * disable locks agents until the guardians re-enable them.
 *
 *   NODE_PATH=../../app/node_modules ../../app/node_modules/.bin/tsx tests/multisig-roundtrip-devnet.ts
 *
 * IDL_DIR points at the IDLs matching the deployed programs (default ../idl).
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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

const SPL_STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const STAKE_POOL = new PublicKey("azFVdHtAJN8BX3sbGAYkXvtdjdrT5U6rj9rovvUFos9");
const RESERVE_STAKE = new PublicKey("aRkys1kVHeysrcn9bJFat9FkvoyyYD8M1kK286X3Aro");
const POOL_MINT = new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1");
const MANAGER_FEE_ACCOUNT = new PublicKey("Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1");
const SOL_USD_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const GOVERNANCE_ID = new PublicKey("CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M");
const PROTOCOL_ID = "jito";
const GUARDIAN_ACTION_DISABLE_AGENTS = 4;
const GUARDIAN_ACTION_ENABLE_AGENTS = 6;

function feedHexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

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

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function redactRpc(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return "(configured)";
  }
}

const boundary: string[] = [];

async function expectError(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (error) {
    const text = `${String(error)}\n${((error as { logs?: string[] })?.logs ?? []).join("\n")}`;
    if (!pattern.test(text)) throw new Error(`${label}: wrong reason: ${text.slice(0, 400)}`);
    boundary.push(label);
    console.log("  blocked", label);
    return;
  }
  throw new Error(`boundary breach: ${label}`);
}

async function main() {
  loadLocalEnv();
  const rpc = process.env.RPC || process.env.SOLANA_DEVNET_RPC || "https://api.devnet.solana.com";
  const founder = loadKeypair(path.resolve(__dirname, "../.deploy-wallet-devnet.json"));
  const guardians = [1, 2, 3].map((n) =>
    loadKeypair(path.resolve(__dirname, `../wallets/guardian-${n}.json`))
  );
  const provider = createDevnetProvider(founder, rpc);
  anchor.setProvider(provider);
  const connection = provider.connection;

  const idlDir = process.env.IDL_DIR ? path.resolve(process.env.IDL_DIR) : path.resolve(__dirname, "../idl");
  const coreIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "nave_core.json"), "utf8"));
  const govIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "nave_governance.json"), "utf8"));
  const program = new anchor.Program(coreIdl as anchor.Idl, provider);
  const governance = new anchor.Program(govIdl as anchor.Idl, provider);
  const CORE = program.programId;
  const guardianLock = coreIdl.errors.some((e: { name: string }) => e.name === "AgentsLockedByGuardians");
  const pending: string[] = [];

  console.log("RPC          :", redactRpc(rpc));
  console.log("Founder      :", founder.publicKey.toBase58());
  guardians.forEach((g, i) => console.log(`Guardian ${i + 1}  :`, g.publicKey.toBase58()));

  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const operational = agents[3];
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: founder.publicKey,
        toPubkey: operational.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
      // Venue legs create rent-paid accounts before the role check runs.
      ...agents.slice(0, 3).map((agent) =>
        SystemProgram.transfer({
          fromPubkey: founder.publicKey,
          toPubkey: agent.publicKey,
          lamports: 0.02 * LAMPORTS_PER_SOL,
        })
      )
    )
  );

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
    name: "msig-sol",
    guardianWallets: guardians.map((g) => g.publicKey),
    guardianThreshold: 2,
    agentAuthorities: agents.map((a) => a.publicKey),
    managementFeeBps: 0,
    performanceFeeBps: 1500,
    frozenManagementFeeBps: 0,
    frozenPerformanceFeeBps: 1500,
    privacyMode: 0,
    feeRecipient: feeRecipientAta,
    protocolRevenueWallet: founder.publicKey,
    quorumBps: 6667,
    governanceType: 0,
  };

  console.log("DAO id       :", daoId.toString());
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
  console.log("  DAO created", daoRegistry.toBase58());

  const registry = await (program.account as any).daoRegistry.fetch(daoRegistry);
  const proposalIndex: anchor.BN = registry.nextProposalIndex;
  const proposal = pda(
    [Buffer.from("proposal"), daoRegistry.toBuffer(), proposalIndex.toArrayLike(Buffer, "le", 8)],
    GOVERNANCE_ID
  );
  console.log("Opening policy proposal", proposalIndex.toString());
  await governance.methods
    .createProposal({
      title: "policy-ok",
      description: "three guardian round trip",
      payload: Buffer.alloc(0),
      proposalType: 0,
      votingPeriodSeconds: new anchor.BN(3600),
    })
    .accountsPartial({
      proposer: founder.publicKey,
      globalConfig,
      daoRegistry,
      proposal,
      daoTokenMint: vaultMint,
      tokenRegistry,
      naveCoreProgram: CORE,
      governanceProgram: GOVERNANCE_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  async function cast(voter: Keypair) {
    await governance.methods
      .castVoteWallet(0)
      .accountsPartial({
        voter: voter.publicKey,
        globalConfig,
        daoRegistry,
        guardianConfig,
        proposal,
      })
      .signers([voter])
      .rpc();
    console.log("  vote", voter.publicKey.toBase58());
  }

  async function tryFinalize(): Promise<boolean> {
    try {
      await governance.methods
        .finalizeProposal()
        .accounts({
          authority: founder.publicKey,
          daoRegistry,
          guardianConfig,
          proposal,
        } as any)
        .rpc();
      return true;
    } catch (error) {
      const text = String(error);
      if (!text.includes("VotingPeriodNotEnded")) throw error;
      return false;
    }
  }

  await cast(guardians[0]);
  if (await tryFinalize()) throw new Error("a single guardian finalized the proposal");
  console.log("  one yes vote cannot close the proposal");
  await cast(guardians[1]);
  if (!(await tryFinalize())) throw new Error("two yes votes did not finalize");
  const passed = await (governance.account as any).proposal.fetch(proposal);
  if (Number(passed.status) !== 1) throw new Error(`proposal status ${passed.status}`);
  console.log("  proposal passed with 2 of 3 guardians");

  const assetConfig = pda([Buffer.from("asset_config"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()], CORE);
  const treasuryAsset = pda([Buffer.from("treasury_asset"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()], CORE);
  const assetVault = pda([Buffer.from("asset_vault"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()], CORE);
  await program.methods
    .registerAsset(feedHexToBytes(SOL_USD_FEED_HEX), false, 1)
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

  const pid = Buffer.from(PROTOCOL_ID);
  const strategyPosition = pda([Buffer.from("strategy_position"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()], CORE);
  const strategyEscrow = pda([Buffer.from("strategy_escrow"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()], CORE);
  const positionTokenAccount = pda([Buffer.from("position_token"), daoRegistry.toBuffer(), pid, NATIVE_MINT.toBuffer()], CORE);
  const solFunding = pda([Buffer.from("sol_funding"), daoRegistry.toBuffer()], CORE);
  const tempWsol = pda([Buffer.from("jito_tmp_wsol"), daoRegistry.toBuffer(), NATIVE_MINT.toBuffer()], CORE);
  const stakePoolWithdrawAuthority = pda([STAKE_POOL.toBuffer(), Buffer.from("withdraw")], SPL_STAKE_POOL_PROGRAM);

  await program.methods.initStrategyPosition(PROTOCOL_ID).accounts({
    authority: founder.publicKey,
    globalConfig,
    daoRegistry,
    mint: NATIVE_MINT,
    strategyPosition,
    systemProgram: SystemProgram.programId,
  } as any).rpc();
  await program.methods.initStrategyEscrow(PROTOCOL_ID).accounts({
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
  } as any).rpc();
  await program.methods.configurePositionTargets(PROTOCOL_ID, STAKE_POOL, RESERVE_STAKE).accounts({
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
  } as any).rpc();

  const fundLamports = 0.12 * LAMPORTS_PER_SOL;
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: founder.publicKey, toPubkey: strategyEscrow, lamports: fundLamports }),
      createSyncNativeInstruction(strategyEscrow)
    )
  );

  const signersFor = (signer: Keypair) => (signer === founder ? [] : [signer]);
  const named: [string, Keypair][] = [
    ["executive", agents[0]],
    ["financial", agents[1]],
    ["oversight", agents[2]],
    ["guardian", guardians[0]],
    ["founder", founder],
  ];

  const jitoDeposit = (signer: Keypair, amount: anchor.BN) =>
    program.methods
    .jitoDeposit(amount)
    .accounts({
      authority: signer.publicKey,
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
    .signers(signersFor(signer))
    .rpc();

  const agentSetState = await (program.account as any).agentSet.fetch(agentSet);
  if (!agentSetState.agentsEnabled) {
    await program.methods
      .toggleAgents(true)
      .accountsPartial({ authority: agents[0].publicKey, globalConfig, daoRegistry, agentSet })
      .signers([agents[0]])
      .rpc();
  }

  const depositAmount = new anchor.BN(0.05 * LAMPORTS_PER_SOL);
  for (const [name, signer] of named) {
    await expectError(`${name} jitoDeposit`, () => jitoDeposit(signer, depositAmount), /Unauthorized/);
  }
  const depSig = await jitoDeposit(operational, depositAmount);
  const bsolAfterDep = await getAccount(connection, positionTokenAccount);
  if (bsolAfterDep.amount === 0n) throw new Error("DepositSol produced no bSOL");
  console.log("  bSOL received", bsolAfterDep.amount.toString(), depSig);

  const poolTokens = new anchor.BN(bsolAfterDep.amount.toString());
  const jitoWithdraw = (signer: Keypair) =>
    program.methods
    .jitoWithdraw(poolTokens)
    .accounts({
      authority: signer.publicKey,
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
    .signers(signersFor(signer))
    .rpc();
  for (const [name, signer] of named) {
    await expectError(`${name} jitoWithdraw`, () => jitoWithdraw(signer), /Unauthorized/);
  }
  const wdSig = await jitoWithdraw(operational);
  const bsolAfterWd = await getAccount(connection, positionTokenAccount);
  if (bsolAfterWd.amount !== 0n) throw new Error(`bSOL remaining ${bsolAfterWd.amount}`);

  const toggleAgents = (signer: Keypair, enabled: boolean) =>
    program.methods
      .toggleAgents(enabled)
      .accountsPartial({ authority: signer.publicKey, globalConfig, daoRegistry, agentSet })
      .signers(signersFor(signer))
      .rpc();
  const guardianAgents = (method: "guardianDisableAgents" | "guardianEnableAgents", guardian: Keypair, nonce: anchor.BN) => {
    const actionType = method === "guardianDisableAgents" ? GUARDIAN_ACTION_DISABLE_AGENTS : GUARDIAN_ACTION_ENABLE_AGENTS;
    const guardianAction = pda(
      [Buffer.from("guardian_action"), daoRegistry.toBuffer(), Buffer.from([actionType]), nonce.toArrayLike(Buffer, "le", 8)],
      CORE
    );
    return (program.methods as any)[method](nonce)
      .accountsPartial({ guardian: guardian.publicKey, globalConfig, daoRegistry, guardianConfig, guardianAction, agentSet })
      .signers([guardian])
      .rpc();
  };
  const agentsEnabled = async () => Boolean((await (program.account as any).agentSet.fetch(agentSet)).agentsEnabled);

  console.log("Guardian lock cycle");
  for (const [name, signer] of named.filter(([n]) => n !== "executive")) {
    await expectError(`${name} toggleAgents`, () => toggleAgents(signer, true), /Unauthorized/);
  }
  if (!(await agentsEnabled())) await toggleAgents(agents[0], true);
  if (!(await agentsEnabled())) throw new Error("Executive could not enable agents");
  await expectError("executive disables agents alone", () => toggleAgents(agents[0], false), /AgentsDisableRequiresGuardians/);
  const disableNonce = new anchor.BN(Date.now());
  await guardianAgents("guardianDisableAgents", guardians[0], disableNonce);
  if (!(await agentsEnabled())) throw new Error("one guardian disabled agents");
  console.log("  one guardian cannot disable agents");
  await guardianAgents("guardianDisableAgents", guardians[1], disableNonce);
  if (await agentsEnabled()) throw new Error("two guardians did not disable agents");
  console.log("  agents disabled by 2 of 3 guardians");
  if (guardianLock) {
    await expectError("operational jitoDeposit while disabled", () => jitoDeposit(operational, depositAmount), /AgentsDisabled/);
    await expectError("executive re-enable after guardian lock", () => toggleAgents(agents[0], true), /AgentsLockedByGuardians/);
    const enableNonce = new anchor.BN(Date.now());
    await guardianAgents("guardianEnableAgents", guardians[0], enableNonce);
    await guardianAgents("guardianEnableAgents", guardians[2], enableNonce);
    if (!(await agentsEnabled())) throw new Error("guardian quorum did not re-enable agents");
    console.log("  agents re-enabled by 2 of 3 guardians");
  } else {
    pending.push(
      "venue legs refuse while agents are disabled",
      "Executive cannot re-enable after a guardian disable",
      "guardian quorum re-enable"
    );
    console.log("  deployed program predates the guardian lock; lock checks wait for the upgrade");
  }
  console.log("\n=== SOLANA MULTISIG ROUND TRIP PASSED ===");
  console.log("DAO         :", daoRegistry.toBase58());
  console.log("proposal    :", proposal.toBase58());
  console.log("deposit     :", depSig);
  console.log("withdraw    :", wdSig);
  console.log("blocked     :", boundary.length, "actions");
  if (pending.length) console.log("pending upgrade:", pending.join("; "));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
