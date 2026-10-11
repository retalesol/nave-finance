import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { QUORUM_BPS, BPS_DENOMINATOR } from "./governance-math";
import { usdcToRaw } from "./apy-simulator";
import {
  confirmSignaturePolling,
  createDevnetConnection,
  deriveWsEndpoint,
  patchProviderPollingConfirm,
} from "./devnet-connection";

export { confirmSignaturePolling, deriveWsEndpoint } from "./devnet-connection";

export const AGENT_ROLES = {
  Executive: 0,
  Financial: 1,
  Oversight: 2,
  Operational: 3,
} as const;

export const AGENT_STATUS = {
  Active: 0,
  Paused: 1,
  Revoked: 2,
  Rotating: 3,
} as const;

/** Deterministic non-zero 32-byte reasoning hash for tests. */
export function makeReasoningHash(label: string): number[] {
  return Array.from(createHash("sha256").update(label).digest());
}

export const ZERO_HASH: number[] = Array(32).fill(0);

export const PROPOSAL_TYPE = {
  Policy: 0,
  Strategy: 1,
  SwitchVotingSystem: 7,
  Transfer: 8,
} as const;

/** Mirrors `nave_core::constants::MAX_GUARDIAN_WALLETS`. */
export const MAX_GUARDIAN_WALLETS = 10;

/** guardian_action.action_type for the break-glass agent kill-switch (constants.rs). */
export const GUARDIAN_ACTION_DISABLE_AGENTS = 4;
/** guardian_action.action_type values added with `DaoControl`. */
export const GUARDIAN_ACTION_ENABLE_AGENTS = 6;
export const GUARDIAN_ACTION_RESTORE_AGENT = 7;
export const GUARDIAN_ACTION_CANCEL_AGENT_ROTATION = 8;
/** `DaoControl.pending_agent_changes[].kind` (state/dao_control.rs). */
export const GUARDIAN_CHANGE_ROTATE_KEY = 1;
export const GUARDIAN_CHANGE_SET_STATUS = 2;

export const VOTE_FOR = 0;
export const VOTE_AGAINST = 1;

export interface DaoSetupConfig {
  name: string;
  memberCount: number;
  depositPerMemberUsdc: number;
  guardianCount: number;
  guardianThreshold: number;
  quorumBps?: number;
  /** 0 = Wallet, 1 = Token (default 1 for harness token flows). */
  governanceType?: number;
  /** Equal DAO tokens per member (default 1). */
  tokensPerMember?: bigint;
  /**
   * Per-DAO review window applied before the first proposal (default 60s, the
   * on-chain minimum, so break-glass tests can wait it out). `null` keeps the
   * constitution default.
   */
  reviewWindowSecs?: number | null;
}

export interface InitializedDao {
  config: DaoSetupConfig;
  daoId: anchor.BN;
  daoRegistry: PublicKey;
  treasuryVault: PublicKey;
  vaultAuthority: PublicKey;
  vaultMint: PublicKey;
  vaultTokenAccount: PublicKey;
  assetVaultTokenAccount: PublicKey;
  constitution: PublicKey;
  agentSet: PublicKey;
  guardianConfig: PublicKey;
  tokenRegistry: PublicKey;
  feeConfig: PublicKey;
  feeRecipientAta: PublicKey;
  agents: Keypair[];
  guardians: Keypair[];
  members: Keypair[];
  memberTokenAccounts: Map<string, PublicKey>;
  totalTreasuryRaw: bigint;
}

export class NaveTestHarness {
  readonly provider: anchor.AnchorProvider;
  readonly founder: Keypair;
  readonly core: Program;
  readonly governance: Program;
  readonly execution: Program;
  readonly kamino: Program;
  readonly jito: Program;
  readonly marginfi: Program;

  globalConfig!: PublicKey;
  globalInitialized = false;

  constructor() {
    const env = anchor.AnchorProvider.env();
    const rpc = process.env.ANCHOR_PROVIDER_URL || env.connection.rpcEndpoint;
    const connection = createDevnetConnection(rpc);
    this.provider = new anchor.AnchorProvider(
      connection,
      env.wallet,
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        confirmTransactionInitialTimeout: 120_000,
      }
    );
    patchProviderPollingConfirm(this.provider);
    anchor.setProvider(this.provider);
    this.founder = (this.provider.wallet as anchor.Wallet).payer;
    this.core = anchor.workspace.NaveCore as Program;
    this.governance = anchor.workspace.NaveGovernance as Program;
    this.execution = anchor.workspace.NaveExecution as Program;
    this.kamino = anchor.workspace.NaveKaminoAdapter as Program;
    this.jito = anchor.workspace.NaveJitoAdapter as Program;
    this.marginfi = anchor.workspace.NaveMarginfiAdapter as Program;
  }

  async ensureGlobalConfig(formationFeeLamports = 2 * LAMPORTS_PER_SOL): Promise<void> {
    [this.globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      this.core.programId
    );

    const existing = await this.provider.connection.getAccountInfo(this.globalConfig);
    if (!existing) {
      // Audit ABI: initialize_global_config is now gated to the program's
      // upgrade authority — it requires the program account + its ProgramData
      // account, and the signer must be the on-chain upgrade authority (the
      // localnet deployer/provider wallet satisfies this).
      const [programData] = PublicKey.findProgramAddressSync(
        [this.core.programId.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
      );
      await this.core.methods
        .initializeGlobalConfig(new anchor.BN(formationFeeLamports))
        .accounts({
          authority: this.founder.publicKey,
          globalConfig: this.globalConfig,
          treasury: this.founder.publicKey,
          program: this.core.programId,
          programData,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const [protocolFeeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_fee_vault")],
      this.core.programId
    );
    const feeVaultInfo = await this.provider.connection.getAccountInfo(protocolFeeVault);
    if (!feeVaultInfo) {
      await this.core.methods
        .initializeProtocolFeeVault()
        .accounts({
          authority: this.founder.publicKey,
          globalConfig: this.globalConfig,
          protocolFeeVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    this.globalInitialized = true;
  }

  async airdrop(key: PublicKey, sol = 2): Promise<void> {
    const sig = await this.provider.connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
    await confirmSignaturePolling(this.provider.connection, sig);
  }

  /** Airdrop SOL to multiple keypairs in parallel batches. */
  async airdropMany(keypairs: Keypair[], sol = 5): Promise<void> {
    const batchSize = 8;
    for (let i = 0; i < keypairs.length; i += batchSize) {
      const batch = keypairs.slice(i, i + batchSize);
      const sigs = await Promise.all(
        batch.map((kp) =>
          this.provider.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL)
        )
      );
      await Promise.all(sigs.map((sig) => confirmSignaturePolling(this.provider.connection, sig)));
    }
  }

  async createDao(config: DaoSetupConfig): Promise<InitializedDao> {
    await this.ensureGlobalConfig();

    const agents = Array.from({ length: 4 }, () => Keypair.generate());
    const guardians = Array.from({ length: config.guardianCount }, () => Keypair.generate());
    const members = Array.from({ length: config.memberCount }, () => Keypair.generate());
    await this.airdropMany([...agents, ...guardians, ...members]);

    const global = await this.core.account.naveGlobalConfig.fetch(this.globalConfig);
    const daoId = global.daoCount;

    const [daoRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("dao"), this.founder.publicKey.toBuffer(), daoId.toArrayLike(Buffer, "le", 8)],
      this.core.programId
    );
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [treasuryVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_vault"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [agentSet] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_set"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [feeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [guardianConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("guardian_config"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [constitution] = PublicKey.findProgramAddressSync(
      [Buffer.from("constitution"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [tokenRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_registry"), daoRegistry.toBuffer()],
      this.core.programId
    );
    const [protocolFeeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_fee_vault")],
      this.core.programId
    );

    const vaultMint = await createMint(
      this.provider.connection,
      this.founder,
      this.founder.publicKey,
      null,
      6
    );
    const feeRecipientAta = getAssociatedTokenAddressSync(vaultMint, this.founder.publicKey);

    const params = {
      name: config.name,
      guardianWallets: guardians.map((g) => g.publicKey),
      guardianThreshold: config.guardianThreshold,
      agentAuthorities: agents.map((a) => a.publicKey),
      managementFeeBps: 100,
      performanceFeeBps: 200,
      frozenManagementFeeBps: 50,
      frozenPerformanceFeeBps: 100,
      privacyMode: 0,
      feeRecipient: feeRecipientAta,
      // Audit ABI: `initialize_dao` now requires a non-default protocol revenue
      // wallet (receives the performance skim + annual management fee). The
      // founder doubles as the revenue wallet in the harness, so the revenue
      // token account for fee paths is simply the founder's ATA (feeRecipientAta).
      protocolRevenueWallet: this.founder.publicKey,
      quorumBps: config.quorumBps ?? QUORUM_BPS,
      governanceType: config.governanceType ?? 1, // Token-weighted (default for harness)
    };

    await this.core.methods
      .initializeDao(params)
      .accounts({
        founder: this.founder.publicKey,
        globalConfig: this.globalConfig,
        protocolTreasury: this.founder.publicKey,
        daoRegistry,
        vaultAuthority,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultTokenAccount = getAssociatedTokenAddressSync(vaultMint, vaultAuthority, true);

    await this.core.methods
      .initializeDaoExtensions(params)
      .accounts({
        founder: this.founder.publicKey,
        globalConfig: this.globalConfig,
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
          this.founder.publicKey,
          vaultTokenAccount,
          vaultAuthority,
          vaultMint
        ),
      ])
      .rpc();

    await this.core.methods
      .initializeDaoGovernance(params)
      .accounts({
        founder: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry,
        guardianConfig,
        constitution,
        tokenRegistry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await this.core.methods
      .registerDaoToken("Nave", "NAV", 6, false, new anchor.BN(0))
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
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

    await this.registerTreasuryAsset(daoRegistry, vaultAuthority, treasuryVault, feeConfig, vaultMint, true, 0);
    const assetVaultTokenAccount = this.assetVaultPda(daoRegistry, vaultMint);

    await this.provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.founder.publicKey,
          feeRecipientAta,
          this.founder.publicKey,
          vaultMint
        )
      )
    ).catch(() => {
      // ATA may already exist from a prior DAO in the same session.
    });

    await this.setupConstitution(daoRegistry, constitution);

    const depositRaw = usdcToRaw(config.depositPerMemberUsdc);
    const participationBps = BigInt(config.quorumBps ?? QUORUM_BPS);
    const nonParticipationBps = BigInt(BPS_DENOMINATOR) - participationBps;
    // Reserve enough wallet tokens so members can reach quorum after treasury deposits.
    const votingStake =
      config.tokensPerMember ??
      (depositRaw * participationBps + (nonParticipationBps - 1n)) / nonParticipationBps +
        BigInt(config.memberCount);
    const memberTokenAccounts = new Map<string, PublicKey>();

    for (const member of members) {
      const ata = getAssociatedTokenAddressSync(vaultMint, member.publicKey);
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.founder.publicKey,
          ata,
          member.publicKey,
          vaultMint
        )
      );
      await this.provider.sendAndConfirm(tx);

      const totalCredit = depositRaw + votingStake;
      await mintTo(
        this.provider.connection,
        this.founder,
        vaultMint,
        ata,
        this.founder,
        totalCredit
      );
      // Devnet fast RPCs can serve stale state immediately after a write, so
      // poll the funded balance for a short window before giving up.
      let funded = 0n;
      for (let attempt = 0; attempt < 10; attempt++) {
        const tokenAcc = await getAccount(this.provider.connection, ata);
        funded = tokenAcc.amount;
        if (funded >= totalCredit) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (funded < totalCredit) {
        throw new Error(
          `Member mint underfunded: got ${funded}, need ${totalCredit}`
        );
      }
      memberTokenAccounts.set(member.publicKey.toBase58(), ata);
    }

    let totalTreasuryRaw = 0n;
    for (const member of members) {
      const depositorAta = memberTokenAccounts.get(member.publicKey.toBase58())!;
      await this.core.methods
        .depositToAsset(new anchor.BN(depositRaw.toString()))
        .accounts({
          depositor: member.publicKey,
          daoRegistry,
          mint: vaultMint,
          assetConfig: this.assetConfigPda(daoRegistry, vaultMint),
          treasuryAsset: this.treasuryAssetPda(daoRegistry, vaultMint),
          assetVault: assetVaultTokenAccount,
          depositorTokenAccount: depositorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([member])
        .rpc();
      totalTreasuryRaw += depositRaw;
    }

    await this.revalueTreasury(daoRegistry, treasuryVault, vaultMint, this.founder.publicKey);

    const reviewWindowSecs = config.reviewWindowSecs === undefined ? 60 : config.reviewWindowSecs;
    if (reviewWindowSecs !== null) {
      await this.core.methods
        .setReviewWindow(new anchor.BN(reviewWindowSecs))
        .accountsPartial({
          authority: this.founder.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry,
          constitution,
        })
        .rpc();
    }

    return {
      config,
      daoId,
      daoRegistry,
      treasuryVault,
      vaultAuthority,
      vaultMint,
      vaultTokenAccount,
      assetVaultTokenAccount,
      constitution,
      agentSet,
      guardianConfig,
      tokenRegistry,
      feeConfig,
      feeRecipientAta,
      agents,
      guardians,
      members,
      memberTokenAccounts,
      totalTreasuryRaw,
    };
  }

  private async registerTreasuryAsset(
    daoRegistry: PublicKey,
    vaultAuthority: PublicKey,
    treasuryVault: PublicKey,
    feeConfig: PublicKey,
    mint: PublicKey,
    isStablecoin: boolean,
    assetKind: number
  ): Promise<void> {
    const [assetConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_config"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );
    const [treasuryAsset] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_asset"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );
    const [assetVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_vault"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );

    const existing = await this.provider.connection.getAccountInfo(assetConfig);
    if (!existing) {
      await this.core.methods
        .registerAsset(new Array(32).fill(0), isStablecoin, assetKind)
        .accounts({
          authority: this.founder.publicKey,
          globalConfig: this.globalConfig,
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
        })
        .rpc();
    }

    await this.core.methods
      .setFeeAsset()
      .accounts({
        authority: this.founder.publicKey,
        daoRegistry,
        mint,
        assetConfig,
        feeConfig,
      })
      .rpc();
  }

  async revalueTreasury(
    daoRegistry: PublicKey,
    treasuryVault: PublicKey,
    mint: PublicKey,
    authority: PublicKey = this.founder.publicKey
  ): Promise<void> {
    const assetConfig = this.assetConfigPda(daoRegistry, mint);
    const treasuryAsset = this.treasuryAssetPda(daoRegistry, mint);
    const assetVault = this.assetVaultPda(daoRegistry, mint);
    const [agentSet] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_set"), daoRegistry.toBuffer()],
      this.core.programId
    );

    await this.core.methods
      .revalueTreasury()
      .accounts({
        authority,
        globalConfig: this.globalConfig,
        daoRegistry,
        agentSet,
        treasuryVault,
      })
      .remainingAccounts([
        { pubkey: assetConfig, isWritable: false, isSigner: false },
        { pubkey: treasuryAsset, isWritable: true, isSigner: false },
        { pubkey: assetVault, isWritable: false, isSigner: false },
        { pubkey: assetVault, isWritable: false, isSigner: false },
        ...(await this.principalPositions(daoRegistry)).map((pubkey) => ({
          pubkey,
          isWritable: false,
          isSigner: false,
        })),
      ])
      .rpc();
  }

  /** StrategyPositions holding principal; revalue values each asset at their marks. */
  async principalPositions(daoRegistry: PublicKey): Promise<PublicKey[]> {
    const rows = await (this.core.account as any).strategyPosition.all([
      { memcmp: { offset: 9, bytes: daoRegistry.toBase58() } },
    ]);
    return rows
      .filter((r: any) => BigInt(r.account.depositedAmount.toString()) > 0n)
      .map((r: any) => r.publicKey as PublicKey);
  }

  async setupConstitution(daoRegistry: PublicKey, constitution: PublicKey): Promise<void> {
    await this.core.methods
      .updateConstitution([
        {
          protocolId: "kamino",
          programId: this.kamino.programId,
          maxAllocationBps: 4000,
          approved: true,
        },
        {
          protocolId: "jito",
          programId: this.jito.programId,
          maxAllocationBps: 3000,
          approved: true,
        },
        {
          protocolId: "marginfi",
          programId: this.marginfi.programId,
          maxAllocationBps: 3000,
          approved: true,
        },
      ], null, null)
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry,
        constitution,
      })
      .rpc();
  }

  /**
   * NE-7 canonical Strategy-proposal payload. The execution program recomputes
   * sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32)) at create_execution_request and
   * requires it to equal the governance-committed proposal payload_hash, so the
   * proposal payload MUST be exactly these 72 bytes.
   */
  strategyPayload(protocolProgram: PublicKey, amount: bigint, mint: PublicKey): Buffer {
    const buf = Buffer.alloc(72);
    protocolProgram.toBuffer().copy(buf, 0);
    buf.writeBigUInt64LE(amount, 32);
    mint.toBuffer().copy(buf, 40);
    return buf;
  }

  proposalPda(dao: InitializedDao, proposalIndex: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        dao.daoRegistry.toBuffer(),
        proposalIndex.toArrayLike(Buffer, "le", 8),
      ],
      this.governance.programId
    )[0];
  }

  async createStrategyProposal(
    dao: InitializedDao,
    title: string,
    payload: Buffer,
    votingPeriodSeconds = 2
  ): Promise<{ proposal: PublicKey; proposalIndex: anchor.BN; payloadHash: Buffer }> {
    const registry = await this.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposalIndex = registry.proposalCount;
    const proposal = this.proposalPda(dao, proposalIndex);
    const payloadHash = createHash("sha256").update(payload).digest();

    await this.governance.methods
      .createProposal({
        title,
        description: title,
        payload,
        proposalType: PROPOSAL_TYPE.Strategy,
        votingPeriodSeconds: new anchor.BN(votingPeriodSeconds),
      })
      .accountsPartial({
        proposer: this.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();

    return { proposal, proposalIndex, payloadHash };
  }

  /** Transfer proposal payload: recipient(32) ‖ mint(32) ‖ amount_le(8). */
  transferPayload(recipient: PublicKey, mint: PublicKey, amount: bigint): Buffer {
    const buf = Buffer.alloc(72);
    recipient.toBuffer().copy(buf, 0);
    mint.toBuffer().copy(buf, 32);
    buf.writeBigUInt64LE(amount, 64);
    return buf;
  }

  async createTransferProposal(
    dao: InitializedDao,
    title: string,
    recipient: PublicKey,
    mint: PublicKey,
    amount: bigint,
    votingPeriodSeconds = 60
  ): Promise<{ proposal: PublicKey; proposalIndex: anchor.BN }> {
    const payload = this.transferPayload(recipient, mint, amount);
    const registry = await this.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposalIndex = registry.proposalCount;
    const proposal = this.proposalPda(dao, proposalIndex);

    await this.governance.methods
      .createProposal({
        title,
        description: title,
        payload,
        proposalType: PROPOSAL_TYPE.Transfer,
        votingPeriodSeconds: new anchor.BN(votingPeriodSeconds),
      })
      .accountsPartial({
        proposer: this.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();

    return { proposal, proposalIndex };
  }

  /**
   * SOL-C2 `SwitchVotingSystem` proposal payload:
   * `governance_type(1) ‖ voting_token(32) ‖ guardian_threshold(1) ‖
   * guardian_wallet_count(1) ‖ guardian_wallets(10×32, zero-padded)`.
   * Must match `nave_core::instructions::protocol::parse_switch_voting_payload`.
   */
  switchVotingPayload(
    governanceType: number,
    votingToken: PublicKey,
    guardianThreshold: number,
    guardianWallets: PublicKey[]
  ): Buffer {
    const buf = Buffer.alloc(1 + 32 + 1 + 1 + MAX_GUARDIAN_WALLETS * 32);
    buf.writeUInt8(governanceType, 0);
    votingToken.toBuffer().copy(buf, 1);
    buf.writeUInt8(guardianThreshold, 33);
    buf.writeUInt8(guardianWallets.length, 34);
    guardianWallets.forEach((wallet, i) => wallet.toBuffer().copy(buf, 35 + i * 32));
    return buf;
  }

  async createSwitchVotingProposal(
    dao: InitializedDao,
    title: string,
    payload: Buffer,
    votingPeriodSeconds = 60
  ): Promise<{ proposal: PublicKey; proposalIndex: anchor.BN }> {
    const registry = await this.core.account.daoRegistry.fetch(dao.daoRegistry);
    const proposalIndex = registry.proposalCount;
    const proposal = this.proposalPda(dao, proposalIndex);

    await this.governance.methods
      .createProposal({
        title,
        description: title,
        payload,
        proposalType: PROPOSAL_TYPE.SwitchVotingSystem,
        votingPeriodSeconds: new anchor.BN(votingPeriodSeconds),
      })
      .accountsPartial({
        proposer: this.founder.publicKey,
        daoRegistry: dao.daoRegistry,
        proposal,
        daoTokenMint: dao.vaultMint,
      })
      .rpc();

    return { proposal, proposalIndex };
  }

  /** CPI-only SOL-C2 execution path (nave_governance -> nave_core). */
  async executeSwitchVotingSystem(dao: InitializedDao, proposal: PublicKey): Promise<void> {
    await this.governance.methods
      .executeSwitchVotingSystem()
      .accountsPartial({
        executor: this.founder.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        guardianConfig: dao.guardianConfig,
        tokenRegistry: dao.tokenRegistry,
        proposal,
        naveCoreProgram: this.core.programId,
      })
      .rpc();
  }

  /** Direct (non-CPI) call into nave_core, expected to be rejected post-SOL-C2. */
  async switchVotingSystemDirect(dao: InitializedDao, proposal: PublicKey): Promise<void> {
    await this.core.methods
      .switchVotingSystem()
      .accountsPartial({
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        guardianConfig: dao.guardianConfig,
        tokenRegistry: dao.tokenRegistry,
        proposal,
      })
      .rpc();
  }

  async executeTransferSpl(
    dao: InitializedDao,
    proposal: PublicKey,
    recipient: PublicKey,
    mint: PublicKey
  ): Promise<void> {
    const [assetConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_config"), dao.daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );
    const [treasuryAsset] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_asset"), dao.daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );
    const [assetVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_vault"), dao.daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    );
    const recipientToken = getAssociatedTokenAddressSync(mint, recipient);

    await this.governance.methods
      .executeTreasuryTransferSpl()
      .accountsPartial({
        executor: this.founder.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        proposal,
        vaultAuthority: dao.vaultAuthority,
        mint,
        assetConfig,
        treasuryAsset,
        treasuryVault: dao.treasuryVault,
        assetVault,
        recipient,
        recipientToken,
        naveCoreProgram: this.core.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  voteRecordPda(proposal: PublicKey, voter: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vote_record"), proposal.toBuffer(), voter.toBuffer()],
      this.governance.programId
    )[0];
  }

  voteEscrowPda(proposal: PublicKey, voter: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vote_escrow"), proposal.toBuffer(), voter.toBuffer()],
      this.governance.programId
    )[0];
  }

  async requiredQuorumWeight(dao: InitializedDao, proposal: PublicKey): Promise<bigint> {
    const p = await this.governance.account.proposal.fetch(proposal);
    const registry = await this.core.account.daoRegistry.fetch(dao.daoRegistry);
    return (BigInt(p.snapshotSupply.toString()) * BigInt(registry.quorumBps)) / 10000n;
  }

  /** Lock enough token weight to meet on-chain quorum (35% of snapshot supply). */
  async lockQuorumVotes(
    dao: InitializedDao,
    proposal: PublicKey,
    choice: number,
    targetWeight?: bigint
  ): Promise<void> {
    const required = targetWeight ?? (await this.requiredQuorumWeight(dao, proposal));
    const locks: { member: Keypair; amount: bigint }[] = [];
    let cast = 0n;
    for (const member of dao.members) {
      if (cast >= required) break;
      const ata = dao.memberTokenAccounts.get(member.publicKey.toBase58())!;
      const acc = await getAccount(this.provider.connection, ata);
      const available = BigInt(acc.amount.toString());
      const amount = available < required - cast ? available : required - cast;
      if (amount === 0n) continue;
      locks.push({ member, amount });
      cast += amount;
    }
    if (cast < required) {
      throw new Error(`Quorum weight not reached: cast ${cast}, need ${required}`);
    }
    await Promise.all(
      locks.map(({ member, amount }) =>
        this.lockTokensAndVote(dao, proposal, member, amount, choice)
      )
    );
  }

  /** Return locked governance tokens after a proposal is no longer Active. */
  async releaseVoteEscrows(
    dao: InitializedDao,
    proposal: PublicKey,
    voters: Keypair[]
  ): Promise<void> {
    for (const voter of voters) {
      const voteEscrow = this.voteEscrowPda(proposal, voter.publicKey);
      const escrowAccountInfo = await this.provider.connection.getAccountInfo(voteEscrow);
      if (!escrowAccountInfo) continue;
      const escrowAccount = await this.governance.account.voteEscrow.fetch(voteEscrow);
      if (escrowAccount.released) continue;

      const voterTokenAccount = dao.memberTokenAccounts.get(voter.publicKey.toBase58())!;
      const escrowTokenAccount = getAssociatedTokenAddressSync(
        dao.vaultMint,
        voteEscrow,
        true
      );

      await this.governance.methods
        .releaseVoteEscrow()
        .accountsPartial({
          voter: voter.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          proposal,
          voteEscrow,
          escrowTokenAccount,
          voterTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([voter])
        .rpc();
    }
  }

  /**
   * Meet quorum with an against majority: member[0] votes FOR with all their tokens,
   * the remaining members vote AGAINST with all their tokens.
   *
   * The votingStake formula gives all N members exactly quorum tokens combined, so
   * N-1 AGAINST members always outvote 1 FOR member while meeting quorum (N ≥ 3).
   */
  async lockQuorumSplit(dao: InitializedDao, proposal: PublicKey): Promise<void> {
    for (let i = 0; i < dao.members.length; i++) {
      const member = dao.members[i];
      const ata = dao.memberTokenAccounts.get(member.publicKey.toBase58())!;
      const acc = await getAccount(this.provider.connection, ata);
      const amount = BigInt(acc.amount.toString());
      if (amount > 0n) {
        const choice = i === 0 ? VOTE_FOR : VOTE_AGAINST;
        await this.lockTokensAndVote(dao, proposal, member, amount, choice);
      }
    }
  }

  async lockTokensAndVote(
    dao: InitializedDao,
    proposal: PublicKey,
    member: Keypair,
    amount: bigint,
    choice: number
  ): Promise<void> {
    const voterTokenAccount = dao.memberTokenAccounts.get(member.publicKey.toBase58())!;
    const voteEscrow = this.voteEscrowPda(proposal, member.publicKey);
    const escrowTokenAccount = getAssociatedTokenAddressSync(
      dao.vaultMint,
      voteEscrow,
      true
    );
    const voteRecord = this.voteRecordPda(proposal, member.publicKey);

    const pre: anchor.web3.TransactionInstruction[] = [];
    const escrowInfo = await this.provider.connection.getAccountInfo(escrowTokenAccount);
    if (!escrowInfo) {
      pre.push(
        createAssociatedTokenAccountInstruction(
          this.founder.publicKey,
          escrowTokenAccount,
          voteEscrow,
          dao.vaultMint
        )
      );
    }

    const signers = pre.length > 0 ? [member, this.founder] : [member];

    try {
      await this.governance.methods
        .lockTokensAndVote(new anchor.BN(amount.toString()), choice)
        .accountsPartial({
          voter: member.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          proposal,
          daoTokenMint: dao.vaultMint,
          voterTokenAccount,
          escrowTokenAccount,
          voteEscrow,
          voteRecord,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(pre)
        .signers(signers)
        .rpc();
    } catch (err: unknown) {
      try {
        const tx = await this.governance.methods
          .lockTokensAndVote(new anchor.BN(amount.toString()), choice)
          .accountsPartial({
            voter: member.publicKey,
            globalConfig: this.globalConfig,
            daoRegistry: dao.daoRegistry,
            proposal,
            daoTokenMint: dao.vaultMint,
            voterTokenAccount,
            escrowTokenAccount,
            voteEscrow,
            voteRecord,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(pre)
          .signers(signers)
          .transaction();
        const sim = await this.provider.connection.simulateTransaction(tx, signers);
        const logs = sim.value.logs?.join("\n") ?? "";
        throw new Error(
          `lockTokensAndVote failed: ${JSON.stringify(sim.value.err)}\n${logs}\noriginal: ${String(err)}`
        );
      } catch (simErr) {
        if (simErr !== err && String(simErr).includes("lockTokensAndVote failed")) throw simErr;
      }
      throw err;
    }
  }

  async castGuardianVote(
    dao: InitializedDao,
    proposal: PublicKey,
    guardian: Keypair,
    choice: number
  ): Promise<void> {
    const tx = await this.governance.methods
      .castVoteWallet(choice)
      .accountsPartial({
        voter: guardian.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        guardianConfig: dao.guardianConfig,
        proposal,
      })
      .transaction();
    tx.feePayer = guardian.publicKey;
    tx.recentBlockhash = (
      await this.provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.sign(guardian);
    const sig = await this.provider.connection.sendRawTransaction(tx.serialize());
    await confirmSignaturePolling(this.provider.connection, sig);
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Wait until on-chain voting_end plus buffer (uses cluster block time). */
  async sleepUntilVotingEnd(proposal: PublicKey, bufferMs = 2500): Promise<void> {
    const p = await this.governance.account.proposal.fetch(proposal);
    const slot = await this.provider.connection.getSlot("confirmed");
    const blockTime = await this.provider.connection.getBlockTime(slot);
    const now = blockTime ?? Math.floor(Date.now() / 1000);
    const end = p.votingEnd.toNumber();
    const waitMs = (end - now) * 1000 + bufferMs;
    if (waitMs > 0) await this.sleep(waitMs);
  }

  async finalizeProposal(dao: InitializedDao, proposal: PublicKey): Promise<void> {
    await this.sleepUntilVotingEnd(proposal);
    // On localnet the on-chain clock can lag the RPC block time by a slot or two.
    // Retry up to 5 times with a 1s back-off before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.governance.methods
          .finalizeProposal()
          .accounts({
            authority: this.founder.publicKey,
            globalConfig: this.globalConfig,
            daoRegistry: dao.daoRegistry,
            proposal,
          })
          .rpc();
        return;
      } catch (err: unknown) {
        const msg = String(err);
        if (!msg.includes("VotingPeriodNotEnded")) throw err;
        await this.sleep(1000);
      }
    }
    // Final attempt — let the error propagate.
    await this.governance.methods
      .finalizeProposal()
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        proposal,
      })
      .rpc();
  }

  executionRequestPda(proposal: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("execution_request"), proposal.toBuffer()],
      this.execution.programId
    )[0];
  }

  executionAuthorityPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("execution_authority"), daoRegistry.toBuffer()],
      this.execution.programId
    )[0];
  }

  /**
   * nave_core `DaoLifecycle` companion PDA (moonlight state). Created lazily on
   * the first moonlight action; nave_execution's deposit paths read it (when it
   * exists) to refuse new deployments while the DAO is moonlighting.
   */
  daoLifecyclePda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_lifecycle"), daoRegistry.toBuffer()],
      this.core.programId
    )[0];
  }

  strategyEscrow(dao: InitializedDao): PublicKey {
    return getAssociatedTokenAddressSync(dao.vaultMint, dao.vaultAuthority, true);
  }

  /**
   * NE-9 canonical per-protocol escrow PDA: a token account at
   * [STRATEGY_ESCROW_SEED, dao, protocol_id, mint] owned by the DAO vault_authority,
   * distinct from the vault ATA so deployed capital physically leaves the vault.
   */
  strategyEscrowPda(daoRegistry: PublicKey, protocolId: string, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_escrow"), daoRegistry.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      this.core.programId
    )[0];
  }

  /** Provision the per-protocol escrow (founder-only, idempotent). */
  async initStrategyEscrow(dao: InitializedDao, protocolId: string): Promise<PublicKey> {
    const strategyEscrow = this.strategyEscrowPda(dao.daoRegistry, protocolId, dao.vaultMint);
    const existing = await this.provider.connection.getAccountInfo(strategyEscrow);
    if (existing) return strategyEscrow;

    await this.core.methods
      .initStrategyEscrow(protocolId)
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        vaultTokenAccount: dao.assetVaultTokenAccount,
        mint: dao.vaultMint,
        strategyEscrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return strategyEscrow;
  }

  strategyPositionPda(daoRegistry: PublicKey, protocolId: string, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("strategy_position"), daoRegistry.toBuffer(), Buffer.from(protocolId), mint.toBuffer()],
      this.core.programId
    )[0];
  }

  assetConfigPda(daoRegistry: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("asset_config"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    )[0];
  }

  treasuryAssetPda(daoRegistry: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_asset"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    )[0];
  }

  assetVaultPda(daoRegistry: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("asset_vault"), daoRegistry.toBuffer(), mint.toBuffer()],
      this.core.programId
    )[0];
  }

  async initStrategyPosition(
    dao: InitializedDao,
    _adapterProgram: PublicKey,
    protocolId: string
  ): Promise<void> {
    const strategyPosition = this.strategyPositionPda(dao.daoRegistry, protocolId, dao.vaultMint);
    const existing = await this.provider.connection.getAccountInfo(strategyPosition);
    if (existing) return;

    await this.core.methods
      .initStrategyPosition(protocolId)
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        mint: dao.vaultMint,
        strategyPosition,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async createExecutionRequest(
    dao: InitializedDao,
    proposal: PublicKey,
    amount: bigint,
    adapterProgram: PublicKey
  ): Promise<PublicKey> {
    const executionRequest = this.executionRequestPda(proposal);
    await this.execution.methods
      .createExecutionRequest(
        new anchor.BN(amount.toString()),
        adapterProgram,
        dao.vaultMint,
        false
      )
      .accounts({
        creator: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle: this.daoLifecyclePda(dao.daoRegistry),
        proposal,
        constitution: dao.constitution,
        treasuryVault: dao.treasuryVault,
        executionRequest,
        naveCoreProgram: this.core.programId,
        executionProgram: this.execution.programId,
        // SEC-M4: instructions sysvar forwarded into the bootstrap-latch CPI.
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return executionRequest;
  }

  async completeAgentApprovals(
    dao: InitializedDao,
    executionRequest: PublicKey,
    payloadHash: Buffer
  ): Promise<void> {
    const hashArray = Array.from(payloadHash);
    const base = {
      globalConfig: this.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest,
    };

    await this.execution.methods
      .financialApprove(hashArray, makeReasoningHash("financial"))
      .accounts({ authority: dao.agents[1].publicKey, ...base })
      .signers([dao.agents[1]])
      .rpc();

    await this.execution.methods
      .oversightApprove(hashArray, makeReasoningHash("oversight"))
      .accounts({ authority: dao.agents[2].publicKey, ...base })
      .signers([dao.agents[2]])
      .rpc();
  }

  async runAgentApprovals(
    dao: InitializedDao,
    executionRequest: PublicKey,
    payloadHash: Buffer
  ): Promise<void> {
    const base = {
      globalConfig: this.globalConfig,
      daoRegistry: dao.daoRegistry,
      agentSet: dao.agentSet,
      executionRequest,
    };

    await this.execution.methods
      .executiveApprove(makeReasoningHash("executive"))
      .accounts({ authority: dao.agents[0].publicKey, ...base })
      .signers([dao.agents[0]])
      .rpc();

    const hashArray = Array.from(payloadHash);
    await this.execution.methods
      .financialApprove(hashArray, makeReasoningHash("financial"))
      .accounts({ authority: dao.agents[1].publicKey, ...base })
      .signers([dao.agents[1]])
      .rpc();

    await this.execution.methods
      .oversightApprove(hashArray, makeReasoningHash("oversight"))
      .accounts({ authority: dao.agents[2].publicKey, ...base })
      .signers([dao.agents[2]])
      .rpc();
  }

  async operationalHalt(dao: InitializedDao, executionRequest: PublicKey): Promise<void> {
    await this.execution.methods
      .operationalHalt(makeReasoningHash("operational-halt"))
      .accounts({
        authority: dao.agents[3].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        executionRequest,
      })
      .signers([dao.agents[3]])
      .rpc();
  }

  async operationalClear(
    dao: InitializedDao,
    executionRequest: PublicKey,
    reasonHash: number[] = Array.from({ length: 32 }, (_, i) => i + 1)
  ): Promise<void> {
    await this.execution.methods
      .operationalClear(reasonHash)
      .accounts({
        authority: dao.agents[3].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        executionRequest,
      })
      .signers([dao.agents[3]])
      .rpc();
  }

  /**
   * Guardian-quorum disable (sets `DaoControl.guardian_locked`), which opens the
   * Executive break-glass path. Re-enabling after a guardian disable needs a
   * guardian quorum too (`guardian_enable_agents`).
   */
  async disableAgentsForDirectExecute(dao: InitializedDao, actionNonce = 1): Promise<void> {
    const guardianAction = this.guardianActionPda(
      dao,
      GUARDIAN_ACTION_DISABLE_AGENTS,
      [],
      actionNonce
    );
    const signers = dao.guardians.slice(0, dao.config.guardianThreshold);
    for (const guardian of signers) {
      await this.core.methods
        .guardianDisableAgents(new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  daoControlPda(daoRegistry: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dao_control"), daoRegistry.toBuffer()],
      this.core.programId
    )[0];
  }

  /** `DaoControl` for the DAO, or null if it was never created. */
  async fetchDaoControl(dao: InitializedDao): Promise<any | null> {
    return this.core.account.daoControl
      .fetch(this.daoControlPda(dao.daoRegistry))
      .catch(() => null);
  }

  /** Guardian quorum re-enable (clears the guardian lock). */
  async guardianEnableAgents(
    dao: InitializedDao,
    actionNonce: number,
    signers: Keypair[] = dao.guardians.slice(0, dao.config.guardianThreshold)
  ): Promise<void> {
    const guardianAction = this.guardianActionPda(dao, GUARDIAN_ACTION_ENABLE_AGENTS, [], actionNonce);
    for (const guardian of signers) {
      await this.core.methods
        .guardianEnableAgents(new anchor.BN(actionNonce))
        .accountsPartial({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
          daoControl: this.daoControlPda(dao.daoRegistry),
        })
        .signers([guardian])
        .rpc();
    }
  }

  /**
   * Turn the agent pipeline on. After a guardian-quorum disable only a
   * guardian quorum can re-enable, so this uses that path when locked.
   */
  async enableAgents(dao: InitializedDao): Promise<void> {
    const control = await this.fetchDaoControl(dao);
    if (control?.guardianLocked) {
      await this.guardianEnableAgents(dao, Date.now());
      return;
    }
    await this.core.methods
      .toggleAgents(true)
      .accounts({
        authority: dao.agents[0].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
      })
      .signers([dao.agents[0]])
      .rpc();
  }

  async executeStrategyDirect(
    dao: InitializedDao,
    executionRequest: PublicKey,
    adapterProgram: PublicKey,
    protocolId: string
  ): Promise<void> {
    await this.initStrategyPosition(dao, adapterProgram, protocolId);
    const strategyEscrow = await this.initStrategyEscrow(dao, protocolId);
    const strategyPosition = this.strategyPositionPda(
      dao.daoRegistry,
      protocolId,
      dao.vaultMint
    );
    await this.waitForReviewEnd(executionRequest);

    await this.execution.methods
      .executeStrategyDirect()
      .accounts({
        authority: dao.agents[0].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle: this.daoLifecyclePda(dao.daoRegistry),
        agentSet: dao.agentSet,
        constitution: dao.constitution,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        vaultTokenAccount: dao.assetVaultTokenAccount,
        executionAuthority: this.executionAuthorityPda(dao.daoRegistry),
        adapterProgram,
        mint: dao.vaultMint,
        executionRequest,
        strategyEscrow,
        strategyPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        priceUpdate: dao.daoRegistry,
        naveCoreProgram: this.core.programId,
      })
      .signers([dao.agents[0]])
      .rpc();
  }

  /**
   * Break-glass never skips the review window: wait until the request's
   * `review_end` has passed on-chain (bounded so a 24h window fails fast).
   */
  async waitForReviewEnd(executionRequest: PublicKey, maxWaitSecs = 180): Promise<void> {
    const req = await this.execution.account.executionRequest
      .fetch(executionRequest)
      .catch(() => null);
    if (!req || Number(req.reviewEnd) === 0) return;
    const reviewEnd = Number(req.reviewEnd);
    for (;;) {
      const slot = await this.provider.connection.getSlot("confirmed");
      const now = (await this.provider.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
      const remaining = reviewEnd - now;
      if (remaining < 0) return;
      if (remaining > maxWaitSecs) {
        throw new Error(`review window ends in ${remaining}s; lower it with reviewWindowSecs`);
      }
      await this.sleep(Math.min(remaining + 2, 10) * 1000);
    }
  }

  /** Founder lowers the per-DAO review window (bounded on-chain to 60s..7d). */
  async setReviewWindow(dao: InitializedDao, seconds: number): Promise<void> {
    await this.core.methods
      .setReviewWindow(new anchor.BN(seconds))
      .accounts({
        authority: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        constitution: dao.constitution,
      })
      .rpc();
  }

  /**
   * The production execution path: after the review window has elapsed the
   * permissionless `execute_strategy` deploys capital (no agent disable, unlike
   * `executeStrategyDirect`). Mirrors the ExecuteStrategy account graph.
   */
  async executeStrategy(
    dao: InitializedDao,
    executionRequest: PublicKey,
    adapterProgram: PublicKey,
    protocolId: string,
    executor: Keypair = this.founder
  ): Promise<void> {
    await this.initStrategyPosition(dao, adapterProgram, protocolId);
    const strategyEscrow = await this.initStrategyEscrow(dao, protocolId);
    const strategyPosition = this.strategyPositionPda(dao.daoRegistry, protocolId, dao.vaultMint);

    await this.execution.methods
      .executeStrategy()
      .accounts({
        executor: executor.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        daoLifecycle: this.daoLifecyclePda(dao.daoRegistry),
        constitution: dao.constitution,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        vaultTokenAccount: dao.assetVaultTokenAccount,
        executionAuthority: this.executionAuthorityPda(dao.daoRegistry),
        adapterProgram,
        mint: dao.vaultMint,
        executionRequest,
        strategyEscrow,
        strategyPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        priceUpdate: dao.daoRegistry,
        naveCoreProgram: this.core.programId,
      })
      .signers(executor === this.founder ? [] : [executor])
      .rpc();
  }

  /**
   * Unwind a deployed position back to the vault. Gated to the Executive agent
   * (NE: prevents arbitrary signers triggering an unwind) and capped cumulatively
   * at the originally-deployed amount (NE-8).
   */
  async withdrawFromStrategy(
    dao: InitializedDao,
    executionRequest: PublicKey,
    adapterProgram: PublicKey,
    protocolId: string,
    amount: bigint
  ): Promise<void> {
    const strategyEscrow = this.strategyEscrowPda(dao.daoRegistry, protocolId, dao.vaultMint);
    const strategyPosition = this.strategyPositionPda(dao.daoRegistry, protocolId, dao.vaultMint);

    await this.execution.methods
      .withdrawFromStrategy(new anchor.BN(amount.toString()))
      .accounts({
        executor: dao.agents[0].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        vaultAuthority: dao.vaultAuthority,
        treasuryVault: dao.treasuryVault,
        vaultTokenAccount: dao.assetVaultTokenAccount,
        executionAuthority: this.executionAuthorityPda(dao.daoRegistry),
        adapterProgram,
        mint: dao.vaultMint,
        executionRequest,
        strategyEscrow,
        strategyPosition,
        // Audit ABI: withdrawal now skims the 8.5% performance fee on realized
        // yield to the protocol revenue wallet's ATA, so the fee config and the
        // revenue token account (founder ATA == feeRecipientAta in the harness)
        // are required accounts.
        feeConfig: dao.feeConfig,
        revenueTokenAccount: dao.feeRecipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        priceUpdate: dao.daoRegistry,
        naveCoreProgram: this.core.programId,
      })
      .signers([dao.agents[0]])
      .rpc();
  }

  /** Operational agent expires an InReview request whose window has elapsed. */
  async expireRequest(dao: InitializedDao, executionRequest: PublicKey): Promise<void> {
    await this.execution.methods
      .expireRequest()
      .accounts({
        authority: dao.agents[3].publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        agentSet: dao.agentSet,
        executionRequest,
      })
      .signers([dao.agents[3]])
      .rpc();
  }

  async guardianEmergencyFreeze(
    dao: InitializedDao,
    actionNonce: number,
    signers: Keypair[]
  ): Promise<void> {
    for (const guardian of signers) {
      const guardianAction = PublicKey.findProgramAddressSync(
        [
          Buffer.from("guardian_action"),
          dao.daoRegistry.toBuffer(),
          Buffer.from([0]),
          new anchor.BN(actionNonce).toArrayLike(Buffer, "le", 8),
        ],
        this.core.programId
      )[0];

      await this.core.methods
        .emergencyFreeze(new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  async guardianEmergencyUnfreeze(
    dao: InitializedDao,
    actionNonce: number,
    signers: Keypair[]
  ): Promise<void> {
    for (const guardian of signers) {
      const guardianAction = PublicKey.findProgramAddressSync(
        [
          Buffer.from("guardian_action"),
          dao.daoRegistry.toBuffer(),
          Buffer.from([1]),
          new anchor.BN(actionNonce).toArrayLike(Buffer, "le", 8),
        ],
        this.core.programId
      )[0];

      await this.core.methods
        .emergencyUnfreeze(new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  guardianActionPda(
    dao: InitializedDao,
    actionType: number,
    extraSeeds: Buffer[],
    actionNonce: number
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("guardian_action"),
        dao.daoRegistry.toBuffer(),
        Buffer.from([actionType]),
        ...extraSeeds,
        new anchor.BN(actionNonce).toArrayLike(Buffer, "le", 8),
      ],
      this.core.programId
    )[0];
  }

  /** Guardian multisig update of an agent slot's status (action_type = 2). */
  async guardianUpdateAgentStatus(
    dao: InitializedDao,
    agentSlot: number,
    newStatus: number,
    actionNonce: number,
    signers: Keypair[]
  ): Promise<void> {
    const guardianAction = this.guardianActionPda(
      dao,
      2,
      [Buffer.from([agentSlot]), Buffer.from([newStatus])],
      actionNonce
    );

    for (const guardian of signers) {
      await this.core.methods
        .updateAgentStatus(agentSlot, newStatus, new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  /** Guardian multisig nullification of an agent slot (action_type = 5, SOL-H2). */
  async guardianNullifyAgent(
    dao: InitializedDao,
    role: number,
    actionNonce: number,
    signers: Keypair[]
  ): Promise<void> {
    const guardianAction = this.guardianActionPda(
      dao,
      5,
      [Buffer.from([role])],
      actionNonce
    );

    for (const guardian of signers) {
      await this.core.methods
        .nullifyAgent(role, new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  /** Guardian multisig rotation of an agent slot's key (action_type = 3). */
  async guardianRotateAgentKey(
    dao: InitializedDao,
    agentSlot: number,
    newPubkey: PublicKey,
    actionNonce: number,
    signers: Keypair[]
  ): Promise<void> {
    const guardianAction = this.guardianActionPda(
      dao,
      3,
      [Buffer.from([agentSlot]), newPubkey.toBuffer()],
      actionNonce
    );

    for (const guardian of signers) {
      await this.core.methods
        .rotateAgentKey(agentSlot, newPubkey, new anchor.BN(actionNonce))
        .accounts({
          guardian: guardian.publicKey,
          globalConfig: this.globalConfig,
          daoRegistry: dao.daoRegistry,
          guardianConfig: dao.guardianConfig,
          guardianAction,
          agentSet: dao.agentSet,
          systemProgram: SystemProgram.programId,
        })
        .signers([guardian])
        .rpc();
    }
  }

  /** Mint simulated DeFi yield into the vault (represents harvest from strategy escrow). */
  async simulateYieldDeposit(
    dao: InitializedDao,
    yieldRaw: bigint
  ): Promise<void> {
    const yieldSourceAta = getAssociatedTokenAddressSync(dao.vaultMint, this.founder.publicKey);

    // Ensure the yield source ATA exists (it was created as feeRecipientAta in createDao but
    // may need re-creation in edge cases).
    await this.provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.founder.publicKey,
          yieldSourceAta,
          this.founder.publicKey,
          dao.vaultMint
        )
      )
    ).catch(() => { /* already exists */ });

    await mintTo(
      this.provider.connection,
      this.founder,
      dao.vaultMint,
      yieldSourceAta,
      this.founder,
      yieldRaw  // pass bigint directly to avoid Number precision issues
    );

    // Brief pause so the mint is visible to preflight simulation on localnet.
    await this.sleep(150);

    await this.core.methods
      .depositToVault(new anchor.BN(yieldRaw.toString()))
      .accounts({
        depositor: this.founder.publicKey,
        globalConfig: this.globalConfig,
        daoRegistry: dao.daoRegistry,
        treasuryVault: dao.treasuryVault,
        // Audit ABI: legacy deposit_to_vault now requires the asset's mint +
        // asset_config so it can confirm the asset is a registered stablecoin
        // and scale base units to micro-USD (non-stablecoin deposits are
        // hard-blocked). The vault_authority account was removed.
        mint: dao.vaultMint,
        assetConfig: this.assetConfigPda(dao.daoRegistry, dao.vaultMint),
        depositorTokenAccount: yieldSourceAta,
        vaultTokenAccount: dao.vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async expectError(fn: () => Promise<unknown>, fragment: string): Promise<void> {
    try {
      await fn();
      throw new Error(`expected error containing "${fragment}"`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('expected error containing')) throw e;
      if (!msg.includes(fragment)) {
        throw new Error(`expected "${fragment}" in: ${msg}`);
      }
    }
  }
}

export function pctOfTreasury(totalRaw: bigint, bps: number): bigint {
  return (totalRaw * BigInt(bps)) / 10_000n;
}
