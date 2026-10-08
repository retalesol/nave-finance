import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { utils as anchorUtils } from '@coral-xyz/anchor';
import { AccountLayout as SplTokenAccountLayout } from '@solana/spl-token';
import { getNavePrograms, getConnection } from './naveProgram';
import {
  getDaoRegistryPDA,
  getProposalPDA,
  getExecutionRequestPDA,
  getTreasuryVaultPDA,
  getVaultAuthorityPDA,
  getStrategyPositionForMintPDA,
  getHolderAnnotationPDA,
  getGuardianActionPDA,
  getConstitutionPDA,
  getGuardianConfigPDA,
  getAgentSetPDA,
  getTokenRegistryPDA,
  getFeeConfigPDA,
  getNaveGlobalConfigPDA,
  getTreasuryAssetPDA,
  getAssetVaultPDA,
  getVoteRecordPDA,
} from './pdaDerivation';
import type {
  NaveGlobalConfig,
  DaoRegistry,
  AgentSet,
  AgentSlot,
  GuardianConfig,
  TreasuryConstitution,
  TokenRegistry,
  FeeConfig,
  Proposal,
  ExecutionRequest,
  StrategyPosition,
  HolderAnnotation,
  GuardianAction,
  ProtocolEntry,
  TokenSlot,
} from './onChainTypes';
import {
  AgentRole,
  AgentStatus,
  PrivacyMode,
  ProposalType,
  ProposalStatus,
  ExecutionStatus,
  VoteChoice,
} from './onChainTypes';

export { getConnection };

// ─── Decode helpers ──────────────────────────────────────────────────────────

type AnyBN = { toString: () => string } | number | bigint | null | undefined;

/** Convert a BN/number/bigint to a JS number (string round-trip avoids 2^53 throw). */
function num(x: AnyBN): number {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'number') return x;
  return Number(x.toString());
}

/** Pubkey → base58 string. */
function pk(x: { toString: () => string } | null | undefined): string {
  return x ? x.toString() : '';
}

/** Fixed-size byte array (+ length) → utf8 string. */
function bytesToString(arr: ArrayLike<number> | undefined, len: number): string {
  if (!arr) return '';
  const slice = Array.from(arr as ArrayLike<number>).slice(0, len);
  return Buffer.from(slice).toString('utf8').replace(/\0+$/, '');
}

/** Byte array → hex string. */
function hashHex(arr: ArrayLike<number> | undefined): string {
  if (!arr) return '';
  return Buffer.from(Array.from(arr as ArrayLike<number>)).toString('hex');
}

function isNonZero(arr: ArrayLike<number> | undefined): boolean {
  if (!arr) return false;
  return Array.from(arr as ArrayLike<number>).some((b) => b !== 0);
}

const REVIEW_WINDOW_SECONDS = 24 * 60 * 60;

/** Solana RPC hard limit for `getMultipleAccountsInfo` in a single call. */
const GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE = 100;

/**
 * Batched `getMultipleAccountsInfo`, chunked to the RPC's ~100-account limit
 * per call. Preserves input order across chunks so callers can zip results
 * back against the original pubkey/index list. Used to replace N+1 per-item
 * `getAccountInfo`/`fetch` loops with O(N/100) RPC round-trips.
 */
async function getMultipleAccountsInfoChunked(
  connection: Connection,
  pubkeys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  if (pubkeys.length === 0) return [];
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < pubkeys.length; i += GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE) {
    chunks.push(pubkeys.slice(i, i + GET_MULTIPLE_ACCOUNTS_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map((chunk) => connection.getMultipleAccountsInfo(chunk)),
  );
  return results.flat();
}

// ─── nave_core fetchers ──────────────────────────────────────────────────────

export async function fetchNaveGlobalConfig(
  _connection?: Connection,
): Promise<NaveGlobalConfig | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getNaveGlobalConfigPDA();
    const acc = await core.account.naveGlobalConfig.fetchNullable(pda);
    if (!acc) return null;
    return {
      authority: pk(acc.authority),
      paused: acc.paused,
      formationFeeLamports: num(acc.formationFeeLamports),
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchNaveGlobalConfig failed:', err);
    return null;
  }
}

/**
 * Borsh-encoded length (incl. the 8-byte discriminator) of the PRE-BOOTSTRAP
 * `DaoRegistry` layout. The bootstrap release appended a 1-byte `bootstrap_used`
 * field, so the regenerated IDL now expects {@link DAO_REGISTRY_NEW_LEN} bytes.
 * Accounts created by the currently-deployed (pre-bootstrap) program are exactly
 * this size and the new IDL's typed coder throws decoding them ("offset out of
 * range"). We pad such accounts with a single zero byte (`bootstrap_used = false`)
 * so existing DAOs remain readable until the program is redeployed and the
 * account is realloc'd.
 */
const DAO_REGISTRY_OLD_LEN = 160;
const DAO_REGISTRY_NEW_LEN = 161;

/**
 * Fetch + decode a `DaoRegistry` account tolerantly. Reads the raw account and
 * pads the legacy (pre-bootstrap) layout by one zero byte before decoding so the
 * appended `bootstrap_used` field does not break reads of DAOs created by the
 * currently-deployed program. Returns null when the account is missing.
 */
async function fetchDaoRegistryAccountTolerant(
  connection: Connection,
  // deno-lint-ignore no-explicit-any
  core: any,
  pda: PublicKey,
  // deno-lint-ignore no-explicit-any
): Promise<any | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  let data: Buffer = info.data;
  // Only the exact-old-size layout is padded; anything else decodes as-is so we
  // never resurrect genuinely-incompatible/older accounts as garbage.
  if (data.length === DAO_REGISTRY_OLD_LEN) {
    data = Buffer.concat([data, Buffer.alloc(DAO_REGISTRY_NEW_LEN - DAO_REGISTRY_OLD_LEN)]);
  }
  return core.coder.accounts.decode('daoRegistry', data);
}

// deno-lint-ignore no-explicit-any
function decodeDaoRegistryAccount(acc: any): DaoRegistry {
  const rawNext = acc.nextProposalIndex ?? acc.next_proposal_index;
  return {
    founder: pk(acc.founder),
    daoId: num(acc.daoId),
    // Derive from the on-chain enum (0 = Wallet, 1 = Token) instead of hardcoding.
    governanceType: num(acc.governanceType) === 1 ? 'token' : 'wallet',
    frozen: acc.frozen,
    proposalCount: num(acc.proposalCount),
    archivedProposalCount: num(acc.archivedProposals),
    nextProposalIndex:
      rawNext !== undefined && rawNext !== null ? num(rawNext as AnyBN) : undefined,
    executionRequestCount: 0,
    privacyMode: acc.privacyMode as PrivacyMode,
    agentsEnabled: acc.agentsEnabled,
    quorumBps: acc.quorumBps,
    createdAt: num(acc.createdAt),
    frozenAt: 0,
    bump: acc.bump,
  };
}

export async function fetchDaoRegistry(
  founder: PublicKey,
  daoIndex: number,
  _connection?: Connection,
): Promise<DaoRegistry | null> {
  try {
    const { core, connection } = getNavePrograms(_connection);
    const [pda] = getDaoRegistryPDA(founder, daoIndex);
    const acc = await fetchDaoRegistryAccountTolerant(connection, core, pda);
    if (!acc) return null;
    return decodeDaoRegistryAccount(acc);
  } catch (err) {
    console.warn('fetchDaoRegistry failed:', err);
    return null;
  }
}

/**
 * Fetch a DAO registry by its on-chain account address directly. The DAO
 * address IS the registry PDA, so this avoids re-deriving from (founder,
 * dao_id) — which silently fetches the wrong/empty account whenever the cached
 * dao_id is stale or missing (the desync the dashboard hit).
 */
export async function fetchDaoRegistryByAddress(
  daoAddress: PublicKey,
  _connection?: Connection,
): Promise<DaoRegistry | null> {
  try {
    const { core, connection } = getNavePrograms(_connection);
    const acc = await fetchDaoRegistryAccountTolerant(connection, core, daoAddress);
    if (!acc) return null;
    return decodeDaoRegistryAccount(acc);
  } catch (err) {
    console.warn('fetchDaoRegistryByAddress failed:', err);
    return null;
  }
}

export async function fetchAgentSet(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<AgentSet | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getAgentSetPDA(daoPubkey);
    const acc = await core.account.agentSet.fetchNullable(pda);
    if (!acc) return null;

    const mapSlot = (s: {
      role: number;
      authority: { toString: () => string };
      active: boolean;
      nullified: boolean;
      status: number;
    }): AgentSlot => ({
      pubkey: pk(s.authority),
      role: s.role as AgentRole,
      canSign: s.active,
      nullified: s.nullified,
      nullifiedAt: 0,
      actionsCount: 0,
      lastActionAt: 0,
      status: s.status as AgentStatus,
    });

    const agents = acc.agents;
    return {
      dao: pk(acc.dao),
      executive: mapSlot(agents[0]),
      financial: mapSlot(agents[1]),
      oversight: mapSlot(agents[2]),
      operational: mapSlot(agents[3]),
      agentsEnabled: acc.agentsEnabled,
      reviewWindowSeconds: REVIEW_WINDOW_SECONDS,
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchAgentSet failed:', err);
    return null;
  }
}

export async function fetchGuardianConfig(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<GuardianConfig | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getGuardianConfigPDA(daoPubkey);
    const acc = await core.account.guardianConfig.fetchNullable(pda);
    if (!acc) return null;
    return {
      dao: pk(acc.dao),
      wallets: (acc.wallets as { toString: () => string }[])
        .slice(0, acc.walletCount)
        .map(pk),
      threshold: acc.threshold,
      walletCount: acc.walletCount,
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchGuardianConfig failed:', err);
    return null;
  }
}

export async function fetchConstitution(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<TreasuryConstitution | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getConstitutionPDA(daoPubkey);
    const acc = await core.account.treasuryConstitution.fetchNullable(pda);
    if (!acc) return null;

    const approvedProtocols: ProtocolEntry[] = (acc.protocols as Array<{
      protocolId: number[];
      protocolIdLen: number;
      programId: { toString: () => string };
      maxAllocationBps: number;
      approved: boolean;
    }>)
      .slice(0, acc.protocolCount)
      .map((p) => ({
        protocolId: bytesToString(p.protocolId, p.protocolIdLen),
        programId: pk(p.programId),
        maxAllocationBps: p.maxAllocationBps,
        approved: p.approved,
      }));

    // Continuous-policy fields were appended to the on-chain constitution
    // after the original IDL type was generated. Read them via a localized
    // cast so the fetcher stays decoupled from the (large, generated) IDL TS
    // type. Legacy accounts created before these fields will decode them as
    // undefined; `num()` coerces those to 0 (== "unset").
    const policy = acc as typeof acc & {
      minStablecoinReserveBps?: AnyBN;
      maxTotalDeployedBps?: AnyBN;
      minLiquidityBps?: AnyBN;
      rebalanceFrequencySecs?: AnyBN;
      lastRebalanceAt?: AnyBN;
    };
    const minStablecoinReserveBps = num(policy.minStablecoinReserveBps);
    const maxTotalDeployedBps = num(policy.maxTotalDeployedBps);
    const minLiquidityBps = num(policy.minLiquidityBps);
    const rebalanceFrequencySeconds = num(policy.rebalanceFrequencySecs);
    const lastRebalanceAt = num(policy.lastRebalanceAt);

    // Largest single approved-protocol allocation cap, surfaced for the UI.
    const maxSingleAllocationBps = approvedProtocols.reduce(
      (max, p) => Math.max(max, p.maxAllocationBps),
      0,
    );

    return {
      dao: pk(acc.dao),
      riskPreset: 'custom',
      maxSingleAllocationBps,
      maxTotalDeployedBps,
      rebalanceFrequencySeconds,
      approvedProtocols,
      protocolCount: acc.protocolCount,
      // `minReservesBps` historically meant the liquidity floor; keep it in sync.
      minReservesBps: minLiquidityBps,
      minStablecoinReserveBps,
      minLiquidityBps,
      lastRebalanceAt,
      confidenceThreshold: acc.confidenceThreshold,
      reviewWindowSecs: num(acc.reviewWindowSecs),
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchConstitution failed:', err);
    return null;
  }
}

export async function fetchTokenRegistry(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<TokenRegistry | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getTokenRegistryPDA(daoPubkey);
    const acc = await core.account.tokenRegistry.fetchNullable(pda);
    if (!acc) return null;

    const tokens: TokenSlot[] = (acc.tokens as Array<{
      mint: { toString: () => string };
      authorityRevoked: boolean;
      decimals: number;
      name: number[];
      nameLen: number;
      symbol: number[];
      symbolLen: number;
    }>)
      .slice(0, acc.tokenCount)
      .map((t) => ({
        mint: pk(t.mint),
        name: bytesToString(t.name, t.nameLen),
        symbol: bytesToString(t.symbol, t.symbolLen),
        decimals: t.decimals,
        supply: 0,
        isMinted: true,
        isNaveManaged: true,
        mintAuthorityRevoked: t.authorityRevoked,
        freezeAuthorityRevoked: false,
        metadataAuthorityRevoked: false,
        canReceiveProposals: true,
        createdAt: 0,
      }));

    return {
      dao: pk(acc.dao),
      tokens,
      tokenCount: acc.tokenCount,
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchTokenRegistry failed:', err);
    return null;
  }
}

export async function fetchFeeConfig(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<FeeConfig | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getFeeConfigPDA(daoPubkey);
    const acc = await core.account.feeConfig.fetchNullable(pda);
    if (!acc) return null;
    return {
      dao: pk(acc.dao),
      managementFeeBps: acc.managementFeeBps,
      performanceFeeBps: acc.performanceFeeBps,
      frozenManagementFeeBps: acc.frozenManagementFeeBps,
      frozenPerformanceFeeBps: acc.frozenPerformanceFeeBps,
      feeRecipient: pk(acc.feeRecipient),
      protocolRevenueWallet: pk(acc.protocolRevenueWallet),
      highWaterMark: 0,
      totalFeesCollected: 0,
      frozenSince: 0,
      frozenFeeExpiresAt: 0,
      lastFeeCollectedAt: 0,
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchFeeConfig failed:', err);
    return null;
  }
}

/**
 * Fetch a strategy position for a specific (dao, protocol, mint) triple.
 * Strategy positions are keyed by all three — on-chain seeds are
 * ["strategy_position", dao, protocol_id, mint] (4 seeds).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeStrategyPositionAccount(acc: any): StrategyPosition {
  return {
    dao: pk(acc.dao),
    protocolId: bytesToString(acc.protocolId, acc.protocolIdLen),
    protocolProgram: '',
    depositedAmount: num(acc.depositedAmount),
    receiptTokenMint: '',
    receiptTokenAmount: 0,
    currentValueUsd: num(acc.currentValue),
    lastUpdatedAt: num(acc.lastUpdated),
    bump: acc.bump,
  };
}

export async function fetchStrategyPositionForMint(
  daoPubkey: PublicKey,
  protocolId: string,
  mint: PublicKey,
  _connection?: Connection,
): Promise<StrategyPosition | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getStrategyPositionForMintPDA(daoPubkey, protocolId, mint);
    const acc = await core.account.strategyPosition.fetchNullable(pda);
    if (!acc) return null;
    return decodeStrategyPositionAccount(acc);
  } catch (err) {
    console.warn('fetchStrategyPositionForMint failed:', err);
    return null;
  }
}

/**
 * Batched (protocol × mint) strategy-position lookup — used by the treasury
 * overview to fetch every approved-protocol/registered-asset combination in
 * one `getMultipleAccountsInfo` round-trip instead of N sequential fetches.
 */
export async function fetchStrategyPositionsForMints(
  daoPubkey: PublicKey,
  pairs: Array<{ protocolId: string; mint: PublicKey }>,
  _connection?: Connection,
): Promise<(StrategyPosition | null)[]> {
  if (pairs.length === 0) return [];
  try {
    const { core, connection } = getNavePrograms(_connection);
    const pdas = pairs.map(
      ({ protocolId, mint }) => getStrategyPositionForMintPDA(daoPubkey, protocolId, mint)[0],
    );
    const infos = await getMultipleAccountsInfoChunked(connection, pdas);
    return infos.map((info, i) => {
      if (!info) return null;
      try {
        const acc = core.coder.accounts.decode('strategyPosition', info.data);
        return decodeStrategyPositionAccount(acc);
      } catch (err) {
        console.warn(`fetchStrategyPositionsForMints: failed to decode index ${i}:`, err);
        return null;
      }
    });
  } catch (err) {
    console.warn('fetchStrategyPositionsForMints: batched fetch failed, falling back to per-item fetch:', err);
    return Promise.all(
      pairs.map(({ protocolId, mint }) => fetchStrategyPositionForMint(daoPubkey, protocolId, mint, _connection)),
    );
  }
}

/**
 * @deprecated The 3-seed strategy_position PDA (without mint) no longer exists
 * on-chain. On-chain seeds are ["strategy_position", dao, protocol_id, mint].
 * Use {@link fetchStrategyPositionForMint} instead and pass the asset mint.
 * This stub always returns null to prevent silent wrong-PDA lookups.
 */
export async function fetchStrategyPosition(
  _daoPubkey: PublicKey,
  _protocolId: string,
  _connection?: Connection,
): Promise<StrategyPosition | null> {
  console.warn(
    '[fetchStrategyPosition] DEPRECATED: 3-seed strategy_position PDA no longer exists on-chain. ' +
    'Use fetchStrategyPositionForMint(daoPubkey, protocolId, mint) instead.',
  );
  return null;
}

export async function fetchHolderAnnotation(
  daoPubkey: PublicKey,
  holderPubkey: PublicKey,
  _connection?: Connection,
): Promise<HolderAnnotation | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getHolderAnnotationPDA(daoPubkey, holderPubkey);
    const acc = await core.account.holderAnnotation.fetchNullable(pda);
    if (!acc) return null;
    const statusMap: Record<number, 'pending' | 'approved' | 'denied'> = {
      0: 'pending',
      1: 'approved',
      2: 'denied',
    };
    return {
      dao: pk(acc.dao),
      holder: pk(acc.holder),
      annotation: bytesToString(acc.annotation, acc.annotationLen),
      status: statusMap[acc.status] ?? 'pending',
      setBy: pk(acc.holder),
      respondedAt: num(acc.reviewedAt),
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchHolderAnnotation failed:', err);
    return null;
  }
}

export async function fetchGuardianAction(
  daoPubkey: PublicKey,
  actionType: number,
  nonce: number,
  _connection?: Connection,
): Promise<GuardianAction | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getGuardianActionPDA(daoPubkey, actionType, nonce);
    const acc = await core.account.guardianAction.fetchNullable(pda);
    if (!acc) return null;
    return {
      dao: pk(acc.dao),
      actionType: acc.actionType as 0 | 1,
      nonce: num(acc.nonce),
      confirmations: (acc.wallets as { toString: () => string }[])
        .slice(0, acc.walletCount)
        .map(pk),
      confirmationCount: acc.signatureCount,
      thresholdReached: acc.executed,
      executed: acc.executed,
      bump: acc.bump,
    };
  } catch (err) {
    console.warn('fetchGuardianAction failed:', err);
    return null;
  }
}

/**
 * Guardian M-of-N signatures only accumulate on the SAME GuardianAction PDA,
 * which is derived from (dao, action_type, nonce). To guarantee every guardian
 * converges on one PDA, we discover an already-open action on-chain and reuse
 * its nonce. This is authoritative (reads chain state) and avoids the
 * time-window split race of a purely client-computed nonce.
 *
 * Only used for action types with no extra PDA seeds: 0 = freeze, 1 = unfreeze,
 * 4 = disable_agents. Returns the nonce of the open (not executed, not stale)
 * action with the most signatures, or `null` if none exists (caller should then
 * create a new action with a fresh deterministic nonce).
 *
 * GuardianAction layout after the 8-byte discriminator: bump(u8)@8,
 * dao(pubkey)@9, action_type(u8)@41.
 */
const GUARDIAN_ACTION_STALE_SECS = 7 * 24 * 60 * 60;
export async function resolveOpenGuardianActionNonce(
  daoPubkey: PublicKey,
  actionType: number,
  _connection?: Connection,
): Promise<number | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const actionTypeByte = anchorUtils.bytes.bs58.encode(
      Uint8Array.from([actionType & 0xff]),
    );
    const all = await core.account.guardianAction.all([
      { memcmp: { offset: 9, bytes: daoPubkey.toBase58() } },
      { memcmp: { offset: 41, bytes: actionTypeByte } },
    ]);
    const now = Math.floor(Date.now() / 1000);
    const open = all
      .map((a) => a.account as {
        executed: boolean;
        createdAt: AnyBN;
        nonce: AnyBN;
        signatureCount: number;
      })
      .filter((a) => !a.executed)
      .filter((a) => {
        const createdAt = num(a.createdAt);
        return createdAt > 0 && now - createdAt <= GUARDIAN_ACTION_STALE_SECS;
      })
      .sort((a, b) => (b.signatureCount ?? 0) - (a.signatureCount ?? 0));
    if (open.length === 0) return null;
    return num(open[0].nonce);
  } catch (err) {
    console.warn('resolveOpenGuardianActionNonce failed:', err);
    return null;
  }
}

// ─── nave_governance fetchers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeProposalAccount(acc: any): Proposal {
  return {
    dao: pk(acc.dao),
    index: num(acc.proposalIndex),
    proposer: pk(acc.proposer),
    proposalType: acc.proposalType as ProposalType,
    title: bytesToString(acc.title, acc.titleLen),
    description: bytesToString(acc.description, acc.descriptionLen),
    payloadHash: hashHex(acc.payloadHash),
    votesFor: num(acc.votesFor),
    votesAgainst: num(acc.votesAgainst),
    votesAbstain: num(acc.votesAbstain),
    voterCount: 0,
    status: acc.status as ProposalStatus,
    voteTokenMint: '',
    snapshotSlot: num(acc.snapshotSlot),
    snapshotSupply: num(acc.snapshotSupply),
    // Read from account if present — older IDL builds may omit these, fall back to 0.
    quorumBps: num((acc as Record<string, unknown>).quorumBps ?? 0),
    threshold: num((acc as Record<string, unknown>).threshold ?? 0),
    votingEnd: num(acc.votingEnd),
    createdAt: num(acc.createdAt),
    executedAt: num(acc.finalizedAt),
    archived: false,
    bump: acc.bump,
  };
}

export async function fetchProposal(
  daoPubkey: PublicKey,
  proposalIndex: number,
  _connection?: Connection,
): Promise<Proposal | null> {
  try {
    const { governance } = getNavePrograms(_connection);
    const [pda] = getProposalPDA(daoPubkey, proposalIndex);
    const acc = await governance.account.proposal.fetchNullable(pda);
    if (!acc) return null;
    return decodeProposalAccount(acc);
  } catch (err) {
    console.warn('fetchProposal failed:', err);
    return null;
  }
}

/**
 * Read this voter's recorded choice on a proposal (wallet or token escrow mode).
 * Returns null when no vote account exists yet.
 */
export async function fetchVoterChoiceOnProposal(
  daoPubkey: PublicKey,
  proposalIndex: number,
  voter: PublicKey,
  _connection?: Connection,
): Promise<'for' | 'against' | 'abstain' | null> {
  try {
    const { governance } = getNavePrograms(_connection);
    const [proposalPda] = getProposalPDA(daoPubkey, proposalIndex);
    const [voteRecordPda] = getVoteRecordPDA(proposalPda, voter);
    const rec = await governance.account.voteRecord.fetchNullable(voteRecordPda);
    if (!rec) return null;
    const c = Number((rec as { choice?: unknown }).choice);
    if (c === VoteChoice.For) return 'for';
    if (c === VoteChoice.Against) return 'against';
    if (c === VoteChoice.Abstain) return 'abstain';
    return null;
  } catch (err) {
    console.warn('fetchVoterChoiceOnProposal failed:', err);
    return null;
  }
}

/**
 * Read the raw UTF-8 payload stored on a proposal account. Used to decode the
 * constitution policy carried by a policy proposal when the founder ratifies it.
 */
export async function fetchProposalPayload(
  daoPubkey: PublicKey,
  proposalIndex: number,
  _connection?: Connection,
): Promise<string | null> {
  try {
    const { governance } = getNavePrograms(_connection);
    const [pda] = getProposalPDA(daoPubkey, proposalIndex);
    const acc = await governance.account.proposal.fetchNullable(pda);
    if (!acc) return null;
    return bytesToString(acc.payload, num(acc.payloadLen));
  } catch (err) {
    console.warn('fetchProposalPayload failed:', err);
    return null;
  }
}

/** Fetch the raw proposal payload as a byte array.
 *  Use this for binary-encoded payloads (e.g. TokenMint, SwitchVotingSystem)
 *  where the bytes must not be interpreted as UTF-8. */
export async function fetchProposalPayloadBytes(
  daoPubkey: PublicKey,
  proposalIndex: number,
  _connection?: Connection,
): Promise<number[] | null> {
  try {
    const { governance } = getNavePrograms(_connection);
    const [pda] = getProposalPDA(daoPubkey, proposalIndex);
    const acc = await governance.account.proposal.fetchNullable(pda);
    if (!acc) return null;
    const len = num(acc.payloadLen);
    return Array.from(acc.payload as ArrayLike<number>).slice(0, len);
  } catch (err) {
    console.warn('fetchProposalPayloadBytes failed:', err);
    return null;
  }
}

// ─── nave_execution fetchers ─────────────────────────────────────────────────

/**
 * Borsh-encoded length (incl. discriminator) of the PRE-BOOTSTRAP
 * `ExecutionRequest` layout. The bootstrap release appended a 1-byte `bootstrap`
 * field, so the regenerated IDL expects {@link EXECUTION_REQUEST_NEW_LEN}. The
 * appended field is the LAST field, after every value the app reads, so padding
 * a legacy account with one zero byte (`bootstrap = false`) decodes all consumed
 * fields correctly until the program is redeployed and accounts are realloc'd.
 */
const EXECUTION_REQUEST_OLD_LEN = 362;
const EXECUTION_REQUEST_NEW_LEN = 363;

/** Anchor executionRequest account fields consumed by fetchExecutionRequest. */
interface ExecutionRequestAccountData {
  dao: PublicKey;
  proposal: PublicKey;
  protocolProgram: PublicKey;
  amount: AnyBN;
  status: number;
  updatedAt: AnyBN;
  executiveReasoningHash: number[] | Uint8Array;
  financialReasoningHash: number[] | Uint8Array;
  oversightReasoningHash: number[] | Uint8Array;
  txPayloadHash: number[] | Uint8Array;
  operationalHaltReasonHash: number[] | Uint8Array;
  reviewEnd: AnyBN;
  executedAt: AnyBN;
  bump: number;
}

/** Pad the legacy (pre-bootstrap) `ExecutionRequest` layout by one zero byte so the
 *  appended trailing `bootstrap` field decodes as `false` instead of throwing. */
function padExecutionRequestData(data: Buffer): Buffer {
  if (data.length === EXECUTION_REQUEST_OLD_LEN) {
    return Buffer.concat([data, Buffer.alloc(EXECUTION_REQUEST_NEW_LEN - EXECUTION_REQUEST_OLD_LEN)]);
  }
  return data;
}

function decodeExecutionRequestAccount(acc: ExecutionRequestAccountData): ExecutionRequest {
  const statusNum = acc.status as number;
  const updatedAt = num(acc.updatedAt);
  const hasExec = isNonZero(acc.executiveReasoningHash);
  const hasFin = isNonZero(acc.financialReasoningHash);
  const hasOver = isNonZero(acc.oversightReasoningHash);

  return {
    dao: pk(acc.dao),
    proposal: pk(acc.proposal),
    protocolProgram: pk(acc.protocolProgram),
    amount: num(acc.amount),
    status: statusNum as ExecutionStatus,
    executiveApprovedAt: hasExec ? updatedAt : 0,
    financialApprovedAt: hasFin ? updatedAt : 0,
    oversightApprovedAt: hasOver ? updatedAt : 0,
    txPayloadHash: hashHex(acc.txPayloadHash),
    oversightPayloadHash: hashHex(acc.txPayloadHash),
    executiveReasoningHash: hashHex(acc.executiveReasoningHash),
    financialReasoningHash: hashHex(acc.financialReasoningHash),
    oversightReasoningHash: hashHex(acc.oversightReasoningHash),
    operationalHalt: statusNum === ExecutionStatus.Halted,
    operationalHaltReason: '',
    operationalHaltReasonHash: hashHex(acc.operationalHaltReasonHash),
    operationalCleared: false,
    reviewWindowEndsAt: num(acc.reviewEnd),
    executedAt: num(acc.executedAt),
    agentsBypassed: false,
    protocolName: '',
    bump: acc.bump,
  };
}

export async function fetchExecutionRequest(
  proposalPubkey: PublicKey,
  _connection?: Connection,
): Promise<ExecutionRequest | null> {
  try {
    const { execution, connection } = getNavePrograms(_connection);
    const [pda] = getExecutionRequestPDA(proposalPubkey);
    const info = await connection.getAccountInfo(pda);
    if (!info) return null;
    const data = padExecutionRequestData(info.data);
    const acc = execution.coder.accounts.decode(
      'executionRequest',
      data,
    ) as ExecutionRequestAccountData;
    if (!acc) return null;
    return decodeExecutionRequestAccount(acc);
  } catch (err) {
    console.warn('fetchExecutionRequest failed:', err);
    return null;
  }
}

// ─── Treasury vault ──────────────────────────────────────────────────────────

export async function fetchTreasuryVaultBalance(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<{ lamports: number; sol: number } | null> {
  try {
    const conn = _connection || getConnection();
    const [vaultPda] = getTreasuryVaultPDA(daoPubkey);
    const balance = await conn.getBalance(vaultPda);
    return { lamports: balance, sol: balance / 1_000_000_000 };
  } catch {
    return null;
  }
}

/** Treasury vault accounting (total deposited/withdrawn/NAV/deployed). */
export async function fetchTreasuryVault(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<{
  vaultTokenAccount: string;
  totalDeposited: number;
  totalWithdrawn: number;
  currentNav: number;
  highWaterMark: number;
  deployedCapital: number;
} | null> {
  try {
    const { core } = getNavePrograms(_connection);
    const [pda] = getTreasuryVaultPDA(daoPubkey);
    const acc = await core.account.treasuryVault.fetchNullable(pda);
    if (!acc) return null;
    return {
      vaultTokenAccount: pk(acc.vaultTokenAccount),
      totalDeposited: num(acc.totalDeposited),
      totalWithdrawn: num(acc.totalWithdrawn),
      currentNav: num(acc.currentNav),
      highWaterMark: num(acc.highWaterMark),
      deployedCapital: num(acc.deployedCapital),
    };
  } catch (err) {
    console.warn('fetchTreasuryVault failed:', err);
    return null;
  }
}

export async function fetchVaultAuthorityAddress(daoPubkey: PublicKey): Promise<string> {
  const [pda] = getVaultAuthorityPDA(daoPubkey);
  return pda.toBase58();
}

// ─── Multi-asset treasury ──────────────────────────────────────────────────────

/** A registered treasury asset: config + per-asset accounting + live vault balance. */
export interface RegisteredAssetView {
  mint: string;
  decimals: number;
  /** 64-char hex Pyth feed id (no 0x); all-zero for stablecoins. */
  pythFeedHex: string;
  isStablecoin: boolean;
  assetKind: number; // 0=Stable, 1=SolLike, 2=Other
  enabled: boolean;
  /** Cumulative deposits (base units). */
  deposited: number;
  /** Capital deployed to strategies for this mint (base units). */
  deployedCapital: number;
  /** USD micro-units at the last revalue_treasury. */
  lastValuedUsd: number;
  /** Unix seconds of last valuation, 0 if never. */
  lastValuedAt: number;
  /** Live asset_vault token balance (base units). */
  vaultBalanceBaseUnits: number;
  /** asset_vault PDA (holding token account). */
  assetVault: string;
}

function feedHex(bytes: unknown): string {
  if (!bytes) return '0'.repeat(64);
  const arr = Array.from(bytes as ArrayLike<number>);
  return arr.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/** Decode a raw SPL token account buffer's amount field (base units), or 0 if malformed. */
function decodeTokenAccountAmount(data: Buffer): number {
  try {
    const decoded = SplTokenAccountLayout.decode(data);
    return Number(decoded.amount);
  } catch {
    return 0;
  }
}

/**
 * Enumerate every asset the DAO has registered (one AssetConfig per held mint),
 * joining each with its TreasuryAsset accounting record and live vault balance.
 * Uses a `dao` memcmp filter (offset 9 = 8-byte disc + 1-byte bump) for the
 * initial `assetConfig` scan, then batches the per-asset `treasuryAsset` +
 * `assetVault` reads into two `getMultipleAccountsInfo` calls (instead of
 * 2×N sequential per-asset RPC calls).
 */
export async function fetchRegisteredAssets(
  daoPubkey: PublicKey,
  _connection?: Connection,
): Promise<RegisteredAssetView[]> {
  try {
    const { core, connection } = getNavePrograms(_connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configs: Array<{ publicKey: PublicKey; account: any }> = await core.account.assetConfig.all([
      { memcmp: { offset: 9, bytes: daoPubkey.toBase58() } },
    ]);
    if (configs.length === 0) return [];

    const mints = configs.map(({ account }) => new PublicKey(pk(account.mint)));
    const treasuryAssetPdas = mints.map((mint) => getTreasuryAssetPDA(daoPubkey, mint)[0]);
    const assetVaultPdas = mints.map((mint) => getAssetVaultPDA(daoPubkey, mint)[0]);

    const [treasuryAssetInfos, assetVaultInfos] = await Promise.all([
      getMultipleAccountsInfoChunked(connection, treasuryAssetPdas),
      getMultipleAccountsInfoChunked(connection, assetVaultPdas),
    ]);

    const views: RegisteredAssetView[] = configs.map(({ account }, i) => {
      const mint = mints[i];
      const assetVaultPda = assetVaultPdas[i];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ta: any = null;
      const taInfo = treasuryAssetInfos[i];
      if (taInfo) {
        try {
          ta = core.coder.accounts.decode('treasuryAsset', taInfo.data);
        } catch { /* treasuryAsset always co-created with config; tolerate decode races */ }
      }

      const vaultInfo = assetVaultInfos[i];
      const vaultBalanceBaseUnits = vaultInfo ? decodeTokenAccountAmount(vaultInfo.data) : 0;

      return {
        mint: mint.toBase58(),
        decimals: account.decimals,
        pythFeedHex: feedHex(account.pythFeedId),
        isStablecoin: Boolean(account.isStablecoin),
        assetKind: Number(account.assetKind ?? 0),
        enabled: Boolean(account.enabled),
        deposited: ta ? num(ta.deposited) : 0,
        deployedCapital: ta ? num(ta.deployedCapital) : 0,
        lastValuedUsd: ta ? num(ta.lastValuedUsd) : 0,
        lastValuedAt: ta ? num(ta.lastValuedAt) : 0,
        vaultBalanceBaseUnits,
        assetVault: assetVaultPda.toBase58(),
      };
    });
    return views.sort((a, b) => b.lastValuedUsd - a.lastValuedUsd);
  } catch (err) {
    console.warn('fetchRegisteredAssets failed:', err);
    return [];
  }
}

// ─── Batch fetchers ──────────────────────────────────────────────────────────

/**
 * Fetch all proposals for a DAO (0..proposalCount) in O(proposalCount / 100)
 * RPC round-trips via `getMultipleAccountsInfo`, instead of one `fetch` per
 * proposal. Falls back to the per-item fetcher if the batched call throws
 * (e.g. RPC provider without `getMultipleAccounts` support).
 */
export async function fetchAllProposals(
  daoPubkey: PublicKey,
  proposalCount: number,
  _connection?: Connection,
): Promise<(Proposal | null)[]> {
  if (proposalCount <= 0) return [];
  try {
    const { governance, connection } = getNavePrograms(_connection);
    const pdas = Array.from(
      { length: proposalCount },
      (_, i) => getProposalPDA(daoPubkey, i)[0],
    );
    const infos = await getMultipleAccountsInfoChunked(connection, pdas);
    return infos.map((info, i) => {
      if (!info) return null;
      try {
        const acc = governance.coder.accounts.decode('proposal', info.data);
        return decodeProposalAccount(acc);
      } catch (err) {
        console.warn(`fetchAllProposals: failed to decode proposal index ${i}:`, err);
        return null;
      }
    });
  } catch (err) {
    console.warn('fetchAllProposals: batched fetch failed, falling back to per-item fetch:', err);
    const promises = Array.from({ length: proposalCount }, (_, i) =>
      fetchProposal(daoPubkey, i, _connection),
    );
    return Promise.all(promises);
  }
}

/**
 * Fetch execution requests for a set of proposals (keyed by proposal PDA) in
 * a single batched `getMultipleAccountsInfo` call instead of one `fetch` per
 * proposal. Falls back to the per-item fetcher if the batched call throws.
 */
export async function fetchAllExecutionRequests(
  proposalPubkeys: PublicKey[],
  _connection?: Connection,
): Promise<(ExecutionRequest | null)[]> {
  if (proposalPubkeys.length === 0) return [];
  try {
    const { execution, connection } = getNavePrograms(_connection);
    const pdas = proposalPubkeys.map((pkey) => getExecutionRequestPDA(pkey)[0]);
    const infos = await getMultipleAccountsInfoChunked(connection, pdas);
    return infos.map((info, i) => {
      if (!info) return null;
      try {
        const data = padExecutionRequestData(info.data);
        const acc = execution.coder.accounts.decode(
          'executionRequest',
          data,
        ) as ExecutionRequestAccountData;
        return decodeExecutionRequestAccount(acc);
      } catch (err) {
        console.warn(`fetchAllExecutionRequests: failed to decode index ${i}:`, err);
        return null;
      }
    });
  } catch (err) {
    console.warn('fetchAllExecutionRequests: batched fetch failed, falling back to per-item fetch:', err);
    const promises = proposalPubkeys.map((pkey) => fetchExecutionRequest(pkey, _connection));
    return Promise.all(promises);
  }
}
