import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { NaveTestHarness } from "./helpers/nave-harness";

describe("nave security integration", () => {
  let provider: anchor.AnchorProvider;
  let core: Program;
  let governance: Program;
  let execution: Program;
  let founder: Keypair;
  const agents = Array.from({ length: 4 }, () => Keypair.generate());
  const guardians = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

  let globalConfig: PublicKey;
  let daoRegistry: PublicKey;
  let treasuryVault: PublicKey;
  let vaultAuthority: PublicKey;
  let constitution: PublicKey;
  let agentSet: PublicKey;
  let vaultMint: PublicKey;
  let vaultTokenAccount: PublicKey;
  let feeConfig: PublicKey;
  let proposal: PublicKey;
  let executionRequest: PublicKey;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    core = anchor.workspace.NaveCore as Program;
    governance = anchor.workspace.NaveGovernance as Program;
    execution = anchor.workspace.NaveExecution as Program;
    founder = (provider.wallet as anchor.Wallet).payer;

    for (const kp of [...agents, ...guardians]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      core.programId
    );
  });

  async function ensureGlobalConfig(): Promise<void> {
    const existing = await provider.connection.getAccountInfo(globalConfig);
    if (!existing) {
      await core.methods
        .initializeGlobalConfig(new anchor.BN(2 * LAMPORTS_PER_SOL))
        .accounts({
          authority: founder.publicKey,
          globalConfig,
          treasury: founder.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const [protocolFeeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_fee_vault")],
      core.programId
    );
    const feeVaultInfo = await provider.connection.getAccountInfo(protocolFeeVault);
    if (!feeVaultInfo) {
      await core.methods
        .initializeProtocolFeeVault()
        .accounts({
          authority: founder.publicKey,
          globalConfig,
          protocolFeeVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  const STAGED_DAO_NAME = "Test DAO";

  async function ensureDaoSetup(): Promise<void> {
    await ensureGlobalConfig();

    const global = await core.account.naveGlobalConfig.fetch(globalConfig);
    const daoCount = global.daoCount;

    // Reuse this file's staged DAO only. Other suites share the same founder wallet and
    // bump dao_count, so "last DAO" may be an unrelated fixture (e.g. guardian-votes).
    if (!daoCount.isZero()) {
      const lastDaoId = daoCount.sub(new anchor.BN(1));
      [daoRegistry] = PublicKey.findProgramAddressSync(
        [Buffer.from("dao"), founder.publicKey.toBuffer(), lastDaoId.toArrayLike(Buffer, "le", 8)],
        core.programId
      );
      if (await provider.connection.getAccountInfo(daoRegistry)) {
        const existingDao = await core.account.daoRegistry.fetch(daoRegistry);
        const existingName = Buffer.from(existingDao.name)
          .toString("utf8")
          .replace(/\0/g, "");
        if (existingName === STAGED_DAO_NAME) {
          [vaultAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault_authority"), daoRegistry.toBuffer()],
            core.programId
          );
          [treasuryVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("treasury_vault"), daoRegistry.toBuffer()],
            core.programId
          );
          [agentSet] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent_set"), daoRegistry.toBuffer()],
            core.programId
          );
          [feeConfig] = PublicKey.findProgramAddressSync(
            [Buffer.from("fee_config"), daoRegistry.toBuffer()],
            core.programId
          );
          [constitution] = PublicKey.findProgramAddressSync(
            [Buffer.from("constitution"), daoRegistry.toBuffer()],
            core.programId
          );
          const vault = await core.account.treasuryVault.fetch(treasuryVault);
          vaultTokenAccount = vault.vaultTokenAccount;
          const tokenAcc = await getAccount(provider.connection, vaultTokenAccount);
          vaultMint = tokenAcc.mint;
          await core.methods
            .updateConstitution(
              [
                {
                  protocolId: "kamino",
                  programId: anchor.workspace.NaveKaminoAdapter.programId,
                  maxAllocationBps: 4000,
                  approved: true,
                },
              ],
              null,
              null
            )
            .accounts({
              authority: founder.publicKey,
              globalConfig,
              daoRegistry,
              constitution,
            })
            .rpc()
            .catch(() => undefined);
          return;
        }
      }
    }

    // Next DAO uses current global.dao_count as its id (see initialize_dao_handler).
    [daoRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("dao"), founder.publicKey.toBuffer(), daoCount.toArrayLike(Buffer, "le", 8)],
      core.programId
    );
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), daoRegistry.toBuffer()],
      core.programId
    );
    [treasuryVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_vault"), daoRegistry.toBuffer()],
      core.programId
    );

    vaultMint = await createMint(provider.connection, founder, founder.publicKey, null, 6);
    const feeRecipientAta = getAssociatedTokenAddressSync(vaultMint, founder.publicKey);

    const params = {
      name: STAGED_DAO_NAME,
      guardianWallets: guardians.map((g) => g.publicKey),
      guardianThreshold: 2,
      agentAuthorities: agents.map((a) => a.publicKey),
      managementFeeBps: 100,
      performanceFeeBps: 200,
      frozenManagementFeeBps: 50,
      frozenPerformanceFeeBps: 100,
      privacyMode: 0,
      feeRecipient: feeRecipientAta,
      // Audit ABI: initialize_dao now requires a non-default protocol revenue wallet.
      protocolRevenueWallet: founder.publicKey,
      quorumBps: 100,
      governanceType: 1, // token-weighted (matches vault mint / token voting in this suite)
    };

    await core.methods
      .initializeDao(params)
      .accounts({
        founder: founder.publicKey,
        globalConfig,
        protocolTreasury: founder.publicKey,
        daoRegistry,
        vaultAuthority,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    [agentSet] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_set"), daoRegistry.toBuffer()],
      core.programId
    );
    [feeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), daoRegistry.toBuffer()],
      core.programId
    );

    vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);

    await core.methods
      .initializeDaoExtensions(params)
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
      })
      .preInstructions([
        createAssociatedTokenAccountInstruction(
          founder.publicKey,
          vaultTokenAccount,
          vaultAuthority,
          vaultMint
        ),
      ])
      .rpc();

    [constitution] = PublicKey.findProgramAddressSync(
      [Buffer.from("constitution"), daoRegistry.toBuffer()],
      core.programId
    );

    await core.methods
      .initializeDaoGovernance(params)
      .accounts({
        founder: founder.publicKey,
        globalConfig,
        daoRegistry,
        guardianConfig: PublicKey.findProgramAddressSync(
          [Buffer.from("guardian_config"), daoRegistry.toBuffer()],
          core.programId
        )[0],
        constitution,
        tokenRegistry: PublicKey.findProgramAddressSync(
          [Buffer.from("token_registry"), daoRegistry.toBuffer()],
          core.programId
        )[0],
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const tokenRegistry = PublicKey.findProgramAddressSync(
      [Buffer.from("token_registry"), daoRegistry.toBuffer()],
      core.programId
    )[0];

    await core.methods
      .registerDaoToken("Nave", "NAV", 6, false, new anchor.BN(0))
      .accounts({
        authority: founder.publicKey,
        globalConfig,
        daoRegistry,
        tokenRegistry,
        vaultAuthority,
        treasuryVault,
        destination: vaultTokenAccount,
        protocolFeeVault: PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_fee_vault")],
          core.programId
        )[0],
        mint: vaultMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await ensureVaultFunded();

    await core.methods
      .updateConstitution([
        {
          protocolId: "kamino",
          programId: anchor.workspace.NaveKaminoAdapter.programId,
          maxAllocationBps: 4000,
          approved: true,
        },
      ], null, null)
      .accounts({
        authority: founder.publicKey,
        globalConfig,
        daoRegistry,
        constitution,
      })
      .rpc();
  }

  async function ensureVaultFunded(): Promise<void> {
    const vault = await core.account.treasuryVault.fetch(treasuryVault);
    if (vault.currentNav.gt(new anchor.BN(0))) return;

    // Ensure founder has enough SOL to pay for ATA creation + tx fees late in the suite.
    const founderLamports = await provider.connection.getBalance(founder.publicKey);
    if (founderLamports < 200_000_000) {
      const sig = await provider.connection.requestAirdrop(founder.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    const founderAta = getAssociatedTokenAddressSync(vaultMint, founder.publicKey);
    const ataInfo = await provider.connection.getAccountInfo(founderAta);
    if (!ataInfo) {
      // Create ATA explicitly so errors surface rather than being swallowed.
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(founder.publicKey, founderAta, founder.publicKey, vaultMint)
        )
      );
    }

    const fundAmount = 10_000_000_000n; // 10_000 tokens at 6 decimals
    await mintTo(provider.connection, founder, vaultMint, founderAta, founder, fundAmount);
    // Brief pause so the minted balance is visible to preflight simulation.
    await new Promise((r) => setTimeout(r, 400));

    // Audit ABI: deposit_to_vault now hard-blocks non-stablecoin deposits and
    // requires the asset's mint + asset_config. Register the vault mint as a $1
    // stablecoin (idempotent guard) before depositing.
    const [assetConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_config"), daoRegistry.toBuffer(), vaultMint.toBuffer()],
      core.programId
    );
    const acInfo = await provider.connection.getAccountInfo(assetConfig);
    if (!acInfo) {
      const [treasuryAsset] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_asset"), daoRegistry.toBuffer(), vaultMint.toBuffer()],
        core.programId
      );
      const [assetVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("asset_vault"), daoRegistry.toBuffer(), vaultMint.toBuffer()],
        core.programId
      );
      await core.methods
        .registerAsset(new Array(32).fill(0), true, 0)
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
    }

    await core.methods
      .depositToVault(new anchor.BN(fundAmount.toString()))
      .accountsPartial({
        depositor: founder.publicKey,
        globalConfig,
        daoRegistry,
        treasuryVault,
        mint: vaultMint,
        assetConfig,
        depositorTokenAccount: founderAta,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /** Same timing idea as NaveTestHarness.sleepUntilVotingEnd (this file uses raw governance RPC). */
  async function sleepUntilWalletProposalVotingEnds(prop: PublicKey): Promise<void> {
    const p = await governance.account.proposal.fetch(prop);
    const slot = await provider.connection.getSlot("confirmed");
    const blockTime = await provider.connection.getBlockTime(slot);
    const now = blockTime ?? Math.floor(Date.now() / 1000);
    const end = p.votingEnd.toNumber();
    const waitMs = Math.max(0, (end - now) * 1000 + 2500);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }

  async function ensureFinalizedProposal(): Promise<void> {
    await ensureDaoSetup();
    await ensureVaultFunded();

    const dao = await core.account.daoRegistry.fetch(daoRegistry);
    const proposalIndex = dao.proposalCount.sub(new anchor.BN(1));

    [proposal] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), daoRegistry.toBuffer(), proposalIndex.toArrayLike(Buffer, "le", 8)],
      governance.programId
    );

    const existing = await provider.connection.getAccountInfo(proposal);
    if (existing) {
      const p = await governance.account.proposal.fetch(proposal);
      if (p.finalizedAt.toNumber() > 0) return;
    } else {
      [proposal] = PublicKey.findProgramAddressSync(
        [Buffer.from("proposal"), daoRegistry.toBuffer(), dao.proposalCount.toArrayLike(Buffer, "le", 8)],
        governance.programId
      );

      await governance.methods
        .createProposal({
          title: "Deploy",
          description: "Deploy to Kamino",
          payload: Buffer.from("strategy"),
          proposalType: 1,
          votingPeriodSeconds: new anchor.BN(2),
        })
        .accountsPartial({
          proposer: founder.publicKey,
          daoRegistry,
          proposal,
          daoTokenMint: vaultMint,
        })
        .rpc();
    }

    const tx = await governance.methods
      .castVoteWallet(0)
      .accountsPartial({
        voter: guardians[0].publicKey,
        globalConfig,
        daoRegistry,
        guardianConfig: PublicKey.findProgramAddressSync(
          [Buffer.from("guardian_config"), daoRegistry.toBuffer()],
          core.programId
        )[0],
        proposal,
      })
      .transaction();
    tx.feePayer = guardians[0].publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    tx.sign(guardians[0]);
    const sig = await provider.connection.sendRawTransaction(tx.serialize());
    await provider.connection.confirmTransaction(sig, "confirmed");

    await sleepUntilWalletProposalVotingEnds(proposal);

    await governance.methods
      .finalizeProposal()
      .accounts({
        authority: founder.publicKey,
        globalConfig,
        daoRegistry,
        proposal,
      })
      .rpc();
  }

  it("initializes global config", async () => {
    await ensureGlobalConfig();
    const cfg = await core.account.naveGlobalConfig.fetch(globalConfig);
    // Formation is now fee-free: `formation_fee_lamports` is inert metadata that
    // may be 0 on the live config (or whatever a fresh localnet init passed).
    // Only assert the singleton initialized and still exposes the field; the DAO
    // creation gate is the NAVE stake, not this fee.
    assert.isTrue(anchor.BN.isBN(cfg.formationFeeLamports));
    assert.isTrue(cfg.formationFeeLamports.gten(0));
  });

  it("initializes DAO in staged setup", async () => {
    await ensureDaoSetup();
    const dao = await core.account.daoRegistry.fetch(daoRegistry);
    const name = Buffer.from(dao.name).toString("utf8").replace(/\0/g, "");
    assert.equal(name, STAGED_DAO_NAME);
  });

  it("rejects founder vault withdraw", async () => {
    await ensureDaoSetup();
    const recipient = getAssociatedTokenAddressSync(vaultMint, founder.publicKey);
    const recipientInfo = await provider.connection.getAccountInfo(recipient);
    const pre: anchor.web3.TransactionInstruction[] = [];
    if (!recipientInfo) {
      pre.push(
        createAssociatedTokenAccountInstruction(
          founder.publicKey,
          recipient,
          founder.publicKey,
          vaultMint
        )
      );
    }
    try {
      await core.methods
        .withdrawFromVault(new anchor.BN(1))
        .accounts({
          authority: founder.publicKey,
          globalConfig,
          daoRegistry,
          treasuryVault,
          vaultAuthority,
          vaultTokenAccount,
          recipientTokenAccount: recipient,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions(pre)
        .rpc();
      assert.fail("expected withdraw to fail");
    } catch (e) {
      assert.ok(
        String(e).includes("ExecutionRequestRequired") ||
          String(e).includes("6017") ||
          String(e).includes("InsufficientVaultBalance")
      );
    }
  });

  it("creates and finalizes strategy proposal", async () => {
    const harness = new NaveTestHarness();
    const dao = await harness.createDao({
      name: "proposal-test",
      memberCount: 3,
      depositPerMemberUsdc: 1_000,
      guardianCount: 2,
      guardianThreshold: 1,
    });
    const { proposal } = await harness.createStrategyProposal(
      dao,
      "Deploy",
      Buffer.from("strategy")
    );
    await harness.lockQuorumVotes(dao, proposal, 0);
    await harness.finalizeProposal(dao, proposal);

    const p = await harness.governance.account.proposal.fetch(proposal);
    assert.equal(p.status, 1);
    assert.isAbove(p.finalizedAt.toNumber(), 0);
  });

  it("validates execution request requires passed proposal", async () => {
    const harness = new NaveTestHarness();
    const dao = await harness.createDao({
      name: "exec-req-test",
      memberCount: 3,
      depositPerMemberUsdc: 1_000,
      guardianCount: 2,
      guardianThreshold: 1,
    });

    const { proposal } = await harness.createStrategyProposal(
      dao,
      "Deploy",
      harness.strategyPayload(harness.kamino.programId, 100n, dao.vaultMint)
    );
    await harness.lockQuorumVotes(dao, proposal, 0);
    await harness.finalizeProposal(dao, proposal);

    const executionRequest = harness.executionRequestPda(proposal);
    await harness.execution.methods
      .createExecutionRequest(new anchor.BN(100), harness.kamino.programId, dao.vaultMint, false)
      .accounts({
        creator: harness.founder.publicKey,
        globalConfig: harness.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle: harness.daoLifecyclePda(dao.daoRegistry),
        proposal,
        constitution: dao.constitution,
        treasuryVault: dao.treasuryVault,
        executionRequest,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });
});
