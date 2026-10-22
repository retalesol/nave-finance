import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { findVenue, packSolanaAllocation } from '../../../supabase/functions/_shared/strategyCatalog.ts';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { useAccount, useSignMessage, useSignTypedData } from 'wagmi';
import { parseUnits, type Address } from 'viem';
import { readContract } from '@wagmi/core';
import Fi from '@/components/Fi';
import ProposalStatusStepper from '@/components/governance/ProposalStatusStepper';
import ProposalPayloadSummary from '@/components/governance/ProposalPayloadSummary';
import CharterCheckStatus from '@/components/governance/CharterCheckStatus';
import { useCharterCheck } from '@/hooks/useCharterCheck';
import { useSendTransaction } from '@/hooks/useSendTransaction';
import { useChain } from '@/hooks/useChain';
import { useConstitution } from '@/hooks/useConstitution';
import { useTreasuryAssets } from '@/hooks/useTreasuryAssets';
import { isSelectableTreasuryMint } from '@/lib/treasuryAssetEligibility';
import { isTreasuryOpsFamily } from '@/lib/chain/types';
import { fetchDaoContracts, fetchExecutionRequestsEvm } from '@/lib/evm/readers';
import { NaveTreasuryAbi } from '@/lib/evm/contracts';
import { wagmiConfig } from '@/lib/evm/wagmi';
import { fundExecutiveGas } from '@/lib/createDaoActivationEvm';
import { ensureWalletOnChain } from '@/lib/evm/ensureWalletChain';
import {
  buildApproveErc20Evm,
  buildCastVoteEvm,
  buildCreateStrategyRequestEvm,
  buildExecuteTransferProposalEvm,
  buildExecuteNftTransferProposalEvm,
  buildExecutePermissionProposalEvm,
  buildExecuteSwitchVotingSystemEvm,
  decodeEvmNftTransferRequestPayload,
  decodeEvmPermissionPayload,
  decodeEvmSwitchVotingPayload,
  decodeEvmStrategyProposalPayload,
  buildFinalizeProposalEvm,
  buildMintAdditionalTokensEvm,
  buildReleaseVoteEscrowEvm,
  buildSetPolicyParametersEvm,
  buildUpdateConstitutionEvm,
  type EvmBuildResult,
} from '@/lib/evm/writers';
import {
  buildCastVoteWallet,
  buildLockTokensAndVote,
  buildFinalizeProposal,
  buildCreateExecutionRequest,
  buildUpdateConstitution,
  buildSetPolicyParameters,
  buildMintAdditionalTokens,
  buildReleaseVoteEscrow,
  buildSwitchVotingSystem,
  type ProtocolInput,
  type TransactionBuildResult,
  buildExecuteTreasuryTransferNativeSol,
  buildExecuteTreasuryTransferSpl,
  buildExecuteTreasuryTransferNft,
  decodeSolanaTransferProposalPayload,
} from '@/lib/transactionBuilders';
import { getNavePrograms } from '@/lib/naveProgram';
import { getProposalPDA, getAssetConfigPDA, getNftVaultRecordPDA, getExecutionRequestPDA } from '@/lib/pdaDerivation';
import { fetchTreasuryVault, fetchProposal, fetchProposalPayload, fetchProposalPayloadBytes, fetchExecutionRequest } from '@/lib/onChainFetcher';
import {
  decodeConstitutionPayload,
  decodeEvmStrategyRequestPayload,
  decodeEvmTokenMintPayload,
  decodeEvmTransferRequestPayload,
  rebalanceLabelToSeconds,
} from '@/lib/constitutionPayload';
import { isMockDaoAddress } from '@/lib/mockData';
import {
  getAdapterProgramId,
  getEvmAdapterAddress,
  isConfiguredEvmAdapterAddress,
  MARGINFI_STRATEGY_ENABLED,
  type EvmAdapterProtocolId,
} from '@/lib/programConfig';
import {
  clearHaltViaProxy,
  dispatchViaProxy,
  setAgentsEnabledViaProxy,
  setAgentsEnabledViaProxyEvm,
  solanaAccessSigner,
} from '@/lib/edgeFunctionClient';
import {
  ExecutionStatus,
  ProposalStatus as OnChainProposalStatus,
  ProposalType as OnChainProposalType,
} from '@/lib/onChainTypes';
import {
  TYPE_META,
  STATUS_META,
  SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER,
  canFinalize,
  getPipelineStage,
  isUndefeatable,
  requiredParticipationVotes,
  votingWindowClosed,
  fmtVotes,
  getProposalDescription,
  type Proposal,
} from './types';
import {
  loadPersistedVote,
  persistVote,
  clearPersistedVote,
  resolveEvmProposalPayload,
  loadSolanaStrategyPayload,
  hasStoredStrategyPayload,
} from './proposalStorage';
import {
  isAlreadyVotedError,
  formatVoteSubmissionError,
  formatFinalizeWindowError,
  classifyFinalizeSimulationError,
  formatFinalizeSubmissionError,
} from './voteActionHelpers';

export default function ProposalCard({
  proposal,
  daoAddress,
  isTokenGov,
  votingMint,
  votingTokenDecimals,
  isFounder = false,
  isMember = false,
  guardianCount = 0,
  onChanged,
  highlight = false,
  chainId = null,
}: {
  proposal: Proposal;
  daoAddress: string | null;
  isTokenGov: boolean;
  votingMint: string | null;
  votingTokenDecimals: number;
  isFounder?: boolean;
  /** True when the connected wallet may take member-only actions (vote, finalize, execute). */
  isMember?: boolean;
  /** Guardian wallet count — used for wallet-gov early-finalize detection. */
  guardianCount?: number;
  onChanged?: () => void;
  /** Deep-link highlight — auto-expand and scroll into view. */
  highlight?: boolean;
  /** Treasury chain id so the check matches Ethereum, Base, or Robinhood. */
  chainId?: number | null;
}) {
  const { publicKey, signMessage } = useWallet();
  const { connection } = useConnection();
  const { chainKind, evmChainId, chainFamily } = useChain();
  const { constitution } = useConstitution(daoAddress);
  const { assets: treasuryAssets } = useTreasuryAssets(daoAddress);
  const charter = useCharterCheck(daoAddress, chainId, proposal.actionHash);
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const navigate = useNavigate();
  const tx = useSendTransaction();
  const [expanded, setExpanded] = useState(highlight);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight) return;
    setExpanded(true);
    window.requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [highlight]);
  const [enabling, setEnabling] = useState(false);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);

  // Vote state: EVM still uses localStorage (no VoteRecord fetch here). Solana
  // uses VoteRecord as source of truth — see effect below (localStorage caused
  // false "You voted" when keys were stale or txs never landed).
  const walletStr = chainKind === 'evm' ? evmAddress ?? null : publicKey?.toBase58() ?? null;
  const [myVote, setMyVote] = useState<'for' | 'against' | 'abstain' | null>(() =>
    chainKind === 'solana'
      ? (proposal.myVote ?? null)
      : (proposal.myVote ?? loadPersistedVote(daoAddress, walletStr, proposal.id)),
  );
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState<boolean>(() =>
    chainKind === 'solana'
      ? !!proposal.myVote
      : (!!proposal.myVote || !!loadPersistedVote(daoAddress, walletStr, proposal.id)),
  );

  // When the connected wallet or DAO changes, re-check persisted vote (EVM only).
  useEffect(() => {
    if (chainKind === 'solana') {
      setMyVote(proposal.myVote ?? null);
      setVoted(!!proposal.myVote);
      return;
    }
    const persisted = loadPersistedVote(daoAddress, walletStr, proposal.id);
    setMyVote(proposal.myVote ?? persisted);
    setVoted(!!proposal.myVote || !!persisted);
  }, [walletStr, proposal.id, daoAddress, proposal.myVote, chainKind]);

  // Solana: authoritative vote from on-chain VoteRecord for every proposal status
  // (clears ghost "You voted" on rejected/finalized rows).
  useEffect(() => {
    if (chainKind !== 'solana' || !daoAddress || !publicKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const { fetchVoterChoiceOnProposal } = await import('@/lib/onChainFetcher');
        const onChain = await fetchVoterChoiceOnProposal(
          new PublicKey(daoAddress),
          proposal.number,
          publicKey,
        );
        if (cancelled) return;
        if (onChain) {
          setMyVote(onChain);
          setVoted(true);
          persistVote(daoAddress, publicKey.toBase58(), proposal.id, onChain);
        } else {
          clearPersistedVote(daoAddress, publicKey.toBase58(), proposal.id);
          setMyVote(proposal.myVote ?? null);
          setVoted(!!proposal.myVote);
        }
      } catch {
        if (cancelled) return;
        clearPersistedVote(daoAddress, publicKey.toBase58(), proposal.id);
        setMyVote(proposal.myVote ?? null);
        setVoted(!!proposal.myVote);
      }
    })();
    return () => { cancelled = true; };
  }, [chainKind, daoAddress, proposal.id, proposal.number, publicKey, proposal.myVote]);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [lockAmount, setLockAmount] = useState('');
  const [finalizing, setFinalizing] = useState(false);
  const [createReqAmount, setCreateReqAmount] = useState('1');
  const [createReqProtocol, setCreateReqProtocol] = useState<'kamino' | 'jito' | 'marginfi' | 'jupiter'>('kamino');
  const registeredTreasuryAssets = useMemo(
    () => treasuryAssets.filter((a) => isSelectableTreasuryMint(a)),
    [treasuryAssets],
  );
  const defaultReqAssetMint = useMemo(() => {
    const wsol = registeredTreasuryAssets.find(
      (a) => a.mint === 'So11111111111111111111111111111111111111112' || a.symbol.toUpperCase() === 'WSOL',
    );
    const usdc = registeredTreasuryAssets.find((a) => a.isStablecoin || a.symbol.toUpperCase().includes('USDC'));
    if (createReqProtocol === 'jito' && wsol) return wsol.mint;
    if ((createReqProtocol === 'kamino' || createReqProtocol === 'jupiter' || createReqProtocol === 'marginfi') && usdc) {
      return usdc.mint;
    }
    return registeredTreasuryAssets[0]?.mint ?? votingMint ?? NATIVE_MINT.toBase58();
  }, [registeredTreasuryAssets, createReqProtocol, votingMint]);
  const [createReqAssetMint, setCreateReqAssetMint] = useState<string>(defaultReqAssetMint);
  useEffect(() => {
    setCreateReqAssetMint(defaultReqAssetMint);
  }, [defaultReqAssetMint]);
  const [creatingReq, setCreatingReq] = useState(false);
  const [executingTransfer, setExecutingTransfer] = useState(false);
  const [executingPermission, setExecutingPermission] = useState(false);
  const [executingSwitchVoting, setExecutingSwitchVoting] = useState(false);
  const [ratifying, setRatifying] = useState(false);
  const [ratifyMsg, setRatifyMsg] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [releaseMsg, setReleaseMsg] = useState<string | null>(null);
  const [haltedEr, setHaltedEr] = useState<{ address: string; reason: string } | null>(null);
  const [clearingHalt, setClearingHalt] = useState(false);
  const [clearHaltMsg, setClearHaltMsg] = useState<string | null>(null);
  const [clearHaltError, setClearHaltError] = useState<string | null>(null);

  useEffect(() => {
    if (!daoAddress || isMockDaoAddress(daoAddress) || proposal.type !== 'strategy') {
      setHaltedEr(null);
      return;
    }
    if (proposal.status !== 'passed' && proposal.status !== 'executed') {
      setHaltedEr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (chainKind === 'evm') {
          if (!evmChainId) return;
          const reqs = await fetchExecutionRequestsEvm(evmChainId, daoAddress, proposal.number + 1);
          if (cancelled) return;
          const match = reqs.find((r) => Number(r.proposal) === proposal.number);
          if (match && (match.status === ExecutionStatus.Halted || match.operationalHalt)) {
            setHaltedEr({ address: String(proposal.number), reason: match.operationalHaltReason });
          } else {
            setHaltedEr(null);
          }
          return;
        }
        const daoPk = new PublicKey(daoAddress);
        const [propPda] = getProposalPDA(daoPk, proposal.number);
        const er = await fetchExecutionRequest(propPda);
        if (cancelled) return;
        if (er && (er.status === ExecutionStatus.Halted || er.operationalHalt)) {
          const [erPda] = getExecutionRequestPDA(propPda);
          setHaltedEr({ address: erPda.toBase58(), reason: er.operationalHaltReason });
        } else {
          setHaltedEr(null);
        }
      } catch {
        if (!cancelled) setHaltedEr(null);
      }
    })();
    return () => { cancelled = true; };
  }, [daoAddress, chainKind, evmChainId, proposal.number, proposal.status, proposal.type]);

  async function handleClearProposalHalt() {
    if (!daoAddress || !haltedEr || clearingHalt) return;
    setClearingHalt(true);
    setClearHaltError(null);
    setClearHaltMsg(null);
    try {
      if (chainKind === 'evm') {
        if (!evmAddress || !evmChainId || !isTreasuryOpsFamily(chainFamily)) {
          setClearHaltError('Connect your EVM founder wallet on Ethereum, Base, Robinhood, or Arc.');
          return;
        }
        const { error } = await clearHaltViaProxy({
          daoAddress,
          walletAddress: evmAddress,
          executionRequestAddress: haltedEr.address,
          signChallenge: (m) => signMessageAsync({ message: m }),
          chain: chainFamily,
          chainId: evmChainId,
          index: proposal.number,
        });
        if (error) {
          setClearHaltError(error);
          return;
        }
        setClearHaltMsg('Halt cleared on-chain. The execution request is back in the review window.');
        setHaltedEr(null);
        onChanged?.();
        return;
      }
      if (!publicKey || !signMessage) {
        setClearHaltError('Connect your Solana founder wallet with message signing support.');
        return;
      }
      const { error } = await clearHaltViaProxy({
        daoAddress,
        walletAddress: publicKey.toBase58(),
        executionRequestAddress: haltedEr.address,
        signChallenge: solanaAccessSigner(signMessage),
        chain: 'solana',
      });
      if (error) {
        setClearHaltError(error);
        return;
      }
      setClearHaltMsg('Halt cleared on-chain. The execution request is back in the review window.');
      setHaltedEr(null);
      onChanged?.();
    } catch (err) {
      setClearHaltError(err instanceof Error ? err.message : 'Failed to clear halt.');
    } finally {
      setClearingHalt(false);
    }
  }

  // Persist ratification across reloads (same pattern as vote persistence).
  const ratifyStorageKey = daoAddress ? `ratified:${daoAddress}:${proposal.id}` : null;
  const [alreadyRatified, setAlreadyRatified] = useState<boolean>(() => {
    if (!daoAddress) return false;
    return localStorage.getItem(`ratified:${daoAddress}:${proposal.id}`) === 'true';
  });

  // Ratification is per proposal. Creation itself writes protocols, so a
  // live protocolCount must not mark a later passed policy proposal applied.

  async function handleRatifyTokenMint() {
    if (chainKind === 'evm') {
      if (!daoAddress || ratifying) return;
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      setRatifying(true);
      setVoteError(null);
      setRatifyMsg(null);
      try {
        const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'token-mint');
        if (!payload) {
          setVoteError('Could not recover this EVM token-mint proposal payload from the on-chain payload index. Ratify from the device that created it, or recreate the proposal.');
          return;
        }
        const decoded = decodeEvmTokenMintPayload(payload);
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) {
          setVoteError('EVM contracts are not configured for this network yet.');
          return;
        }
        const outcome = await tx.sendEvm(
          buildMintAdditionalTokensEvm(evmChainId, trio.governor, proposal.number, decoded.mint, decoded.to, decoded.amount),
          { successLabel: `Tokens minted — proposal #${proposal.number} ratified` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          setRatifyMsg('Tokens minted on-chain. The updated supply is visible on the Tokens page.');
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to mint tokens on-chain.');
        }
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to ratify EVM token mint.');
      } finally {
        setRatifying(false);
      }
      return;
    }
    if (!publicKey || !daoAddress || ratifying) return;
    setRatifying(true);
    setVoteError(null);
    setRatifyMsg(null);
    try {
      const daoPubkey = new PublicKey(daoAddress);
      // Defense-in-depth: re-verify on-chain that this is a TokenMint proposal that
      // actually PASSED governance before minting. mint_additional_tokens itself is
      // founder-authorized (the on-chain instruction does not bind a proposal yet —
      // tracked as a contract-side gate), so the client must never submit a mint for
      // a proposal that has not been ratified through the governance vote.
      const onChainProposal = await fetchProposal(daoPubkey, proposal.number);
      if (!onChainProposal) {
        setVoteError('Could not load this proposal on-chain to verify it passed.');
        return;
      }
      if (onChainProposal.status !== OnChainProposalStatus.Passed) {
        setVoteError('This token-mint proposal has not passed governance — minting is only allowed after the vote passes and is ratified.');
        return;
      }
      if (onChainProposal.proposalType !== OnChainProposalType.TokenMint) {
        setVoteError('This proposal is not a token-mint proposal.');
        return;
      }
      // Use raw bytes — the payload is binary (pubkeys + u64), not UTF-8 text.
      const raw = await fetchProposalPayloadBytes(daoPubkey, proposal.number);
      // Payload layout: [destination (32 bytes)] + [mint (32 bytes)] + [amount LE u64 (8 bytes)]
      if (!raw || raw.length < 72) {
        setVoteError('This proposal does not carry a valid token-mint payload (expected 72 bytes).');
        return;
      }
      const destination = new PublicKey(raw.slice(0, 32));
      const mint = new PublicKey(raw.slice(32, 64));
      const amountBytes = raw.slice(64, 72);
      const amount = amountBytes.reduce(
        (acc: bigint, b: number, i: number) => acc + BigInt(b) * (BigInt(256) ** BigInt(i)),
        BigInt(0),
      );
      const outcome = await tx.send(
        await buildMintAdditionalTokens(daoPubkey, publicKey, mint, destination, amount, proposal.number),
        { successLabel: `Tokens minted — proposal #${proposal.number} ratified` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        setRatifyMsg('Tokens minted on-chain. The updated supply is visible on the Tokens page.');
        onChanged?.();
      } else {
        setVoteError(outcome.error || 'Failed to mint tokens on-chain.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to ratify token mint.');
    } finally {
      setRatifying(false);
    }
  }

  /**
   * Execute a passed "Enable Autonomous Agents" proposal. Founder-only: the
   * server proxy re-enables agents on-chain using the DAO's Executive agent key
   * after the founder signs a challenge. This is the same proxy call previously
   * triggered directly from the Agent page, now gated behind a passed DAO vote.
   */
  async function handleExecuteEnableAgents() {
    if (!daoAddress || enabling) return;
    // ── EVM: execute the passed enable proposal via the founder-signed
    // agent-admin → /relay-evm path (Executive EOA calls toggleAgents(true)). ──
    if (chainKind === 'evm') {
      if (!evmChainId || !isTreasuryOpsFamily(chainFamily)) {
        setEnableError('Select an Ethereum, Base, Robinhood, or Arc network.');
        return;
      }
      if (!evmAddress) {
        setEnableError('Connect your EVM founder wallet to execute this proposal.');
        return;
      }
      setEnabling(true);
      setEnableError(null);
      setEnableMsg(null);
      try {
        await ensureWalletOnChain(evmChainId);
        const agent = await readContract(wagmiConfig, {
          address: daoAddress as Address,
          abi: NaveTreasuryAbi,
          functionName: 'agent',
          args: [0],
          chainId: evmChainId,
        });
        const executive = (Array.isArray(agent) ? agent[0] : (agent as { authority: Address }).authority) as Address;
        await fundExecutiveGas(evmChainId, executive);
        // First enable is the Executive key calling toggleAgents(true).
        const { data, error } = await setAgentsEnabledViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          true,
          evmChainId,
          chainFamily,
        );
        if (error || !data?.success) {
          setEnableError(error || data?.error || 'Failed to enable agents on-chain.');
          return;
        }
        setEnableMsg('Agents enabled. The four agents will begin checking this DAO on the next cycle.');
        onChanged?.();
      } catch (err) {
        setEnableError(err instanceof Error ? err.message : 'Failed to enable agents on-chain.');
      } finally {
        setEnabling(false);
      }
      return;
    }
    if (!publicKey) {
      setEnableError('Connect your founder wallet to execute this proposal.');
      return;
    }
    if (!signMessage) {
      setEnableError('Your wallet does not support message signing (required for the enable proxy).');
      return;
    }
    setEnabling(true);
    setEnableError(null);
    setEnableMsg(null);
    try {
      const { data, error } = await setAgentsEnabledViaProxy(
        daoAddress,
        publicKey.toBase58(),
        signMessage,
        true,
      );
      if (error || !data?.success) {
        setEnableError(error || data?.error || 'Failed to enable agents on-chain.');
        return;
      }
      setEnableMsg('Agents enabled. The four agents will begin checking this DAO on the next cycle.');
      onChanged?.();
    } catch (err) {
      setEnableError(err instanceof Error ? err.message : 'Failed to enable agents on-chain.');
    } finally {
      setEnabling(false);
    }
  }

  async function handleRatifyConstitution() {
    if (chainKind === 'evm') {
      if (!daoAddress || ratifying) return;
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      setRatifying(true);
      setVoteError(null);
      setRatifyMsg(null);
      try {
        const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'policy');
        if (!payload) {
          setVoteError('Could not recover this EVM constitution proposal payload from the on-chain payload index. Ratify from the device that created it, or recreate the proposal.');
          return;
        }
        const decoded = decodeConstitutionPayload(payload);
        if (!decoded) {
          setVoteError('This proposal does not carry a decodable constitution payload.');
          return;
        }
        const resolvedProtocols = decoded.protocols.flatMap((p) => {
          const fromPayload = p.adapter && isConfiguredEvmAdapterAddress(evmChainId, p.adapter)
            ? p.adapter
            : null;
          const adapter = fromPayload
            ?? (p.approved ? getEvmAdapterAddress(evmChainId, p.id as EvmAdapterProtocolId) : null);
          if (!adapter) return [];
          return [{ ...p, adapter }];
        });
        const missingAdapters = decoded.protocols.filter(
          (p) => p.approved && !resolvedProtocols.some((r) => r.id === p.id),
        );
        if (missingAdapters.length > 0) {
          setVoteError(
            `EVM adapter addresses are not configured for: ${missingAdapters.map((p) => p.id).join(', ')}. Add adapter addresses to the payload before ratifying.`,
          );
          return;
        }
        const adapters = resolvedProtocols.map((p) => ({
          protocolId: p.id,
          adapter: p.adapter,
          maxAllocationBps: p.maxAllocationBps,
          approved: p.approved,
        }));
        const evmResults: EvmBuildResult[] = [];
        if (adapters.length > 0) {
          evmResults.push(buildUpdateConstitutionEvm(
            evmChainId,
            daoAddress,
            adapters,
            decoded.confidenceThreshold ?? 0,
            constitution?.agentThresholdUsdMicro && constitution.agentThresholdUsdMicro > 0
              ? constitution.agentThresholdUsdMicro
              : 100_000_000,
          ));
        }
        if (
          decoded.minStablecoin != null ||
          decoded.maxDeployment != null ||
          decoded.liquidityReserve != null ||
          decoded.rebalanceFreq != null
        ) {
          evmResults.push(
            buildSetPolicyParametersEvm(
              evmChainId,
              daoAddress,
              Math.round((decoded.minStablecoin ?? 0) * 100),
              Math.round((decoded.maxDeployment ?? 0) * 100),
              Math.round((decoded.liquidityReserve ?? 0) * 100),
              rebalanceLabelToSeconds(decoded.rebalanceFreq),
            ),
          );
        }
        if (evmResults.length === 0) {
          setVoteError('This constitution proposal has no changes to apply.');
          return;
        }
        const outcome = await tx.sendEvm(evmResults, {
          successLabel: `Constitution ratified — agents now follow proposal #${proposal.number}`,
        });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          if (ratifyStorageKey) localStorage.setItem(ratifyStorageKey, 'true');
          setAlreadyRatified(true);
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to apply the constitution on-chain.');
        }
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to ratify the EVM constitution.');
      } finally {
        setRatifying(false);
      }
      return;
    }
    if (!publicKey || !daoAddress || ratifying) return;
    setRatifying(true);
    setVoteError(null);
    setRatifyMsg(null);
    try {
      const daoPubkey = new PublicKey(daoAddress);
      const raw = await fetchProposalPayload(daoPubkey, proposal.number);
      const decoded = decodeConstitutionPayload(raw);
      if (!decoded) {
        setVoteError('This proposal does not carry a decodable constitution payload.');
        return;
      }
      // Re-resolve adapter program IDs at ratify time; skip protocols without one.
      const protocols: ProtocolInput[] = decoded.protocols
        .map((p): ProtocolInput | null => {
          const programId = getAdapterProgramId(p.id);
          if (!programId) return null;
          return {
            protocolId: p.id,
            programId,
            maxAllocationBps: packSolanaAllocation(p.maxAllocationBps, findVenue('solana', p.id)?.tier ?? 1),
            approved: p.approved,
          };
        })
        .filter((p): p is ProtocolInput => p !== null);

      let storedThresholdMicro: number | undefined;
      try {
        const rawThresh = localStorage.getItem(`nave_agent_threshold_micro::${daoAddress.toLowerCase()}`);
        if (rawThresh) {
          const parsed = Number(rawThresh);
          if (Number.isFinite(parsed) && parsed > 0) storedThresholdMicro = parsed;
        }
      } catch { /* ignore */ }
      const preservedThresholdMicro =
        storedThresholdMicro ??
        (constitution?.agentThresholdUsdMicro && constitution.agentThresholdUsdMicro > 0
          ? constitution.agentThresholdUsdMicro
          : undefined);

      // Split into two sequential transactions to stay within the 1232-byte
      // legacy-transaction size limit. update_constitution carries protocol
      // pubkeys + bps data; set_policy_parameters carries numeric policy fields.
      // Grouping both in one tx pushes the size to ~1245 bytes — 13 bytes over.
      const txGroups: TransactionBuildResult[][] = [
        [
          await buildUpdateConstitution(
            daoPubkey,
            publicKey,
            protocols,
            decoded.confidenceThreshold,
            preservedThresholdMicro,
          ),
        ],
      ];
      if (
        decoded.minStablecoin != null ||
        decoded.maxDeployment != null ||
        decoded.liquidityReserve != null ||
        decoded.rebalanceFreq != null
      ) {
        txGroups.push([
          await buildSetPolicyParameters(
            daoPubkey,
            publicKey,
            Math.round((decoded.minStablecoin ?? 0) * 100),
            Math.round((decoded.maxDeployment ?? 0) * 100),
            Math.round((decoded.liquidityReserve ?? 0) * 100),
            rebalanceLabelToSeconds(decoded.rebalanceFreq),
          ),
        ]);
      }
      const outcome = await tx.sendGrouped(txGroups, {
        successLabel: `Constitution ratified — agents now follow proposal #${proposal.number}`,
      });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        if (ratifyStorageKey) localStorage.setItem(ratifyStorageKey, 'true');
        setAlreadyRatified(true);
        onChanged?.();
        // Best-effort: founder-gated poll so the signer pipeline can pick up ERs
        // as soon as Helius/index-events land (orchestrator also scans correct event names).
        if (signMessage) {
          void dispatchViaProxy(daoAddress, publicKey.toBase58(), (m) => signMessage(m)).then(
            ({ error }) => {
              if (error) console.warn('[governance] post-ratify orchestrator poll:', error);
            },
          );
        }
      } else {
        setVoteError(outcome.error || 'Failed to apply the constitution on-chain.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to ratify the constitution.');
    } finally {
      setRatifying(false);
    }
  }

  const statusMeta = STATUS_META[proposal.status];
  const typeMeta = TYPE_META[proposal.type];
  const vf = Number.isFinite(proposal.votesFor) ? proposal.votesFor : 0;
  const va = Number.isFinite(proposal.votesAgainst) ? proposal.votesAgainst : 0;
  const totalCast = vf + va;
  const pctFor = totalCast > 0 ? Math.round((vf / totalCast) * 100) : 0;
  const pctAgainst = totalCast > 0 ? Math.round((va / totalCast) * 100) : 0;
  const gc = guardianCount ?? 0;
  // EVM finalizeProposal settles a missed quorum as `Failed` instead of reverting.
  const quorumRounding = chainKind === 'evm' ? 'ceil' as const : 'floor' as const;
  const finalizeOpts = { allowMissedQuorum: chainKind === 'evm', quorumRounding };
  const finalizable = canFinalize(proposal, gc, finalizeOpts);
  const reqParticipation = requiredParticipationVotes(proposal, gc, quorumRounding);
  const quorumPct =
    reqParticipation > 0 && Number.isFinite(totalCast)
      ? Math.min(100, Math.round((totalCast / reqParticipation) * 100))
      : 0;
  const description = getProposalDescription(proposal.type);

  async function handleVote(vote: 'for' | 'against') {
    if (voted || proposal.status !== 'active') return;
    setVoteError(null);

    if (!daoAddress) {
      setVoteError('Select a treasury before voting.');
      return;
    }
    // Demo DAO: optimistic local vote (no chain). Real DAOs require a connected
    // member wallet — we no longer fake a successful vote when unauthenticated.
    if (isMockDaoAddress(daoAddress)) {
      setMyVote(vote);
      setVoting(true);
      setTimeout(() => { setVoting(false); setVoted(true); }, 800);
      return;
    }

    // ── EVM: cast the vote on the per-DAO governor ──────────────────────────
    if (chainKind === 'evm') {
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { setVoteError('EVM contracts are not configured for this network yet.'); return; }
      const evmChoice = vote === 'for' ? 0 : 1;
      // method 0 = wallet governance, 1 = token escrow; weight is the escrow
      // amount (token base units) and is ignored for wallet votes.
      const method = isTokenGov ? 1 : 0;
      let weight = 0n;
      if (isTokenGov) {
        try {
          weight = parseUnits(lockAmount || '0', votingTokenDecimals);
        } catch {
          setVoteError('Enter a valid token amount to lock for this vote.');
          return;
        }
      }
      if (isTokenGov && weight <= 0n) {
        setVoteError('Enter the number of tokens to lock for this vote.');
        return;
      }
      if (isTokenGov && !votingMint) {
        setVoteError('This DAO has no voting token configured.');
        return;
      }
      setMyVote(vote);
      setVoting(true);
      const evmOutcome = await tx.sendEvm(
        isTokenGov
          ? [
              buildApproveErc20Evm(evmChainId, votingMint!, trio.governor, weight),
              buildCastVoteEvm(evmChainId, trio.governor, proposal.number, evmChoice, method, weight),
            ]
          : buildCastVoteEvm(evmChainId, trio.governor, proposal.number, evmChoice, method, weight),
        { successLabel: `Vote cast — ${vote}`, quietMock: true },
      );
      setVoting(false);
      if (evmOutcome.status === 'success' || evmOutcome.status === 'mock') {
        setVoted(true);
        if (walletStr && daoAddress) persistVote(daoAddress, walletStr, proposal.id, vote);
        onChanged?.();
      } else {
        setMyVote(null);
        setVoteError(evmOutcome.error || 'Vote submission failed.');
      }
      return;
    }

    if (!publicKey) {
      setVoteError('Connect a wallet that is a member of this DAO to vote.');
      return;
    }

    const daoPubkey = new PublicKey(daoAddress);
    const choice = vote === 'for' ? 0 : 1;

    // Token governance locks voting-token weight; wallet governance is 1-wallet
    // 1-vote. The on-chain program enforces the matching mode (Phase 2), so the
    // client must pick the correct instruction.
    let result;
    if (isTokenGov) {
      if (!votingMint) {
        setVoteError('This DAO has no voting token configured.');
        return;
      }
      // FN-H3: scale by the token's actual decimals (mirrors the EVM branch's
      // parseUnits(lockAmount, votingTokenDecimals) above) — lock_tokens_and_vote
      // takes a raw base-unit BN, not a human-readable token count. Passing the
      // human count directly used to under-weight every Solana token vote by a
      // factor of 10^decimals. parseUnits also throws on invalid/malformed input
      // (e.g. more decimal places than the mint supports), so this is wrapped in
      // try/catch — previously a value like "0.5" with certain decimal configs
      // could throw unhandled inside `new BN()`.
      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = parseUnits(lockAmount || '0', votingTokenDecimals);
      } catch {
        setVoteError('Enter a valid token amount to lock for this vote.');
        return;
      }
      if (amountBaseUnits <= 0n) {
        setVoteError('Enter the number of tokens to lock for this vote.');
        return;
      }
      const mint = new PublicKey(votingMint);
      const voterTokenAccount = getAssociatedTokenAddressSync(mint, publicKey, true);
      try {
        result = await buildLockTokensAndVote(
          daoPubkey,
          proposal.number,
          publicKey,
          mint,
          voterTokenAccount,
          amountBaseUnits,
          choice,
        );
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to build the vote transaction.');
        return;
      }
    } else {
      result = await buildCastVoteWallet(daoPubkey, proposal.number, publicKey, choice);
    }

    setMyVote(vote);
    setVoting(true);
    const outcome = await tx.send(result, {
      successLabel: `Vote cast — ${vote}`,
      quietMock: true,
    });

    setVoting(false);
    if (outcome.status === 'mock' || outcome.status === 'success') {
      setVoted(true);
      // Persist the vote so it survives page reloads.
      if (walletStr && daoAddress) persistVote(daoAddress, walletStr, proposal.id, vote);
      onChanged?.();
    } else {
      const rawErr = outcome.error || 'Vote submission failed.';
      const errLower = rawErr.toLowerCase();

      // Detect "already voted" — update state to reflect reality and save to localStorage.
      const isAlreadyVoted = isAlreadyVotedError(errLower);

      if (isAlreadyVoted) {
        // The attempt is not the vote that landed. Keep the stored choice.
        setVoted(true);
        const stored = walletStr && daoAddress ? loadPersistedVote(daoAddress, walletStr, proposal.id) : null;
        setMyVote(stored);
        setVoteError('Your vote has already been recorded on-chain.');
        return;
      }

      setMyVote(null);
      setVoteError(formatVoteSubmissionError(rawErr));
    }
  }

  async function handleFinalize() {
    // ── EVM: finalize on the per-DAO governor ───────────────────────────────
    if (chainKind === 'evm') {
      if (finalizing || !daoAddress) return;
      setVoteError(null);
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      if (!canFinalize(proposal, guardianCount, { allowMissedQuorum: true, quorumRounding: 'ceil' })) {
        setVoteError('Not enough yes votes to close early. Another guardian can vote, or wait until the voting window ends.');
        return;
      }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { setVoteError('EVM contracts are not configured for this network yet.'); return; }
      setFinalizing(true);
      try {
        const evmOutcome = await tx.sendEvm(
          buildFinalizeProposalEvm(evmChainId, trio.governor, proposal.number),
          { successLabel: `Proposal #${proposal.number} finalized` },
        );
        if (evmOutcome.status === 'success' || evmOutcome.status === 'mock') {
          if (walletStr && daoAddress) clearPersistedVote(daoAddress, walletStr, proposal.id);
          onChanged?.();
        } else {
          setVoteError(evmOutcome.error || 'Finalize failed.');
        }
      } finally {
        setFinalizing(false);
      }
      return;
    }

    if (!publicKey || !daoAddress || finalizing) return;
    setVoteError(null);

    // Client-side guard — the on-chain instruction also checks this but the
    // wallet shows "Unexpected error" for custom Anchor errors, which is confusing.
    if (!canFinalize(proposal, guardianCount)) {
      setVoteError(formatFinalizeWindowError(proposal.votingEndTimestamp));
      return;
    }

    setFinalizing(true);
    try {
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildFinalizeProposal(daoPubkey, proposal.number, publicKey);

      // Pre-simulate to surface errors before the wallet prompt.
      // NOTE: simulateTransaction with an unsigned tx can return false-positive
      // GlobalPaused errors due to signer resolution quirks, so we only block
      // on errors we're certain are reliable (not GlobalPaused).
      if (result.instruction) {
        try {
          const { blockhash } = await connection.getLatestBlockhash();
          const simTx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
          simTx.add(result.instruction);
          const simResult = await connection.simulateTransaction(simTx);
          if (simResult.value.err) {
            const logs = simResult.value.logs ?? [];
            const errorLine = logs.find(l =>
              l.includes('AnchorError') || l.includes('Error') || l.includes('custom program error'),
            ) ?? '';
            console.warn('[finalize simulation] error:', errorLine, simResult.value.err);

            // Only block on errors that are definitely real (not GlobalPaused which
            // can be a simulation false-positive on unsigned transactions).
            const simMsg = classifyFinalizeSimulationError(errorLine);
            if (simMsg) {
              setFinalizing(false);
              setVoteError(simMsg);
              return;
            }
            // For other errors (GlobalPaused, DaoOwnershipMismatch, etc.) fall through
            // to the actual wallet transaction — simulation may be a false positive.
          }
        } catch (simErr) {
          // Simulation threw an exception (e.g. RPC error, unsigned-tx rejection).
          // Fall through to the actual wallet transaction — simulation may be a
          // false positive — but warn the user so they can review carefully.
          console.warn('[finalize simulation] exception:', simErr);
          setVoteError(
            'Pre-flight simulation failed — proceeding with transaction anyway. ' +
            'Review carefully in your wallet before approving.',
          );
        }
      }

      // For strategy proposals: if the creation payload was stored locally,
      // bundle finalize_proposal + create_execution_request in a single tx.
      // Within a Solana transaction, state written by an earlier instruction is
      // visible to subsequent CPIs, so the execution request can read the
      // Passed status set by finalize_proposal atomically.
      if (proposal.type === 'strategy') {
        const rawPayload = loadSolanaStrategyPayload(daoAddress, proposal.number);
        if (rawPayload) {
          try {
            const daoPubkey = new PublicKey(daoAddress);
            const [proposalPda] = getProposalPDA(daoPubkey, proposal.number);
            const execReqResult = await buildCreateExecutionRequest(
              daoPubkey,
              proposalPda,
              publicKey,
              rawPayload.amount,
              new PublicKey(rawPayload.adapter),
              new PublicKey(rawPayload.mint),
            );
            const bundledOutcome = await tx.sendGrouped([[result, execReqResult]], {
              successLabel: `Proposal #${proposal.number} finalized and queued for execution`,
            });
            if (bundledOutcome.status === 'success' || bundledOutcome.status === 'mock') {
              if (walletStr && daoAddress) clearPersistedVote(daoAddress, walletStr, proposal.id);
              onChanged?.();
            } else {
              setVoteError(formatFinalizeSubmissionError(bundledOutcome.error || 'Finalize + execution request failed.'));
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Finalize failed — please try again.';
            console.error('[handleFinalize] bundled finalize+execReq error:', e);
            setVoteError(msg);
          } finally {
            setFinalizing(false);
          }
          return;
        }
      }

      const outcome = await tx.send(result, { successLabel: `Proposal #${proposal.number} finalized` });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        // Clear persisted vote once the proposal is finalized — it's no longer active.
        if (walletStr && daoAddress) clearPersistedVote(daoAddress, walletStr, proposal.id);
        onChanged?.();
      } else {
        setVoteError(formatFinalizeSubmissionError(outcome.error || 'Finalize failed.'));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Finalize failed — please try again.';
      console.error('[handleFinalize] unexpected error:', e);
      setVoteError(msg);
    } finally {
      setFinalizing(false);
    }
  }

  /**
   * Reclaim governance tokens locked for a vote, once the proposal is no longer
   * Active. Token voters lock weight via lock_tokens_and_vote; release_vote_escrow
   * returns those tokens from the per-(proposal, voter) escrow to the voter's ATA.
   */
  async function handleReleaseEscrow() {
    // ── EVM: release the vote escrow on the per-DAO governor ────────────────
    if (chainKind === 'evm') {
      if (releasing || !daoAddress) return;
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { setVoteError('EVM contracts are not configured for this network yet.'); return; }
      setReleasing(true);
      setVoteError(null);
      setReleaseMsg(null);
      try {
        const evmOutcome = await tx.sendEvm(
          buildReleaseVoteEscrowEvm(evmChainId, trio.governor, proposal.number),
          { successLabel: 'Locked tokens reclaimed' },
        );
        if (evmOutcome.status === 'success' || evmOutcome.status === 'mock') {
          setReleaseMsg('Your locked voting tokens have been returned to your wallet.');
          onChanged?.();
        } else {
          setVoteError(evmOutcome.error || 'Failed to release locked tokens.');
        }
      } finally {
        setReleasing(false);
      }
      return;
    }

    if (!publicKey || !daoAddress || !votingMint || releasing) return;
    setReleasing(true);
    setVoteError(null);
    setReleaseMsg(null);
    try {
      const daoPubkey = new PublicKey(daoAddress);
      const mint = new PublicKey(votingMint);
      const voterTokenAccount = getAssociatedTokenAddressSync(mint, publicKey, true);
      const outcome = await tx.send(
        await buildReleaseVoteEscrow(daoPubkey, proposal.number, publicKey, mint, voterTokenAccount),
        { successLabel: 'Locked tokens reclaimed' },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        setReleaseMsg('Your locked voting tokens have been returned to your wallet.');
        onChanged?.();
      } else {
        const err = outcome.error || 'Failed to release locked tokens.';
        setVoteError(
          err.toLowerCase().includes('no') || err.toLowerCase().includes('not found')
            ? 'No locked tokens found for this proposal under the connected wallet.'
            : err,
        );
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to release locked tokens.');
    } finally {
      setReleasing(false);
    }
  }

  async function handleExecutePermission() {
    if (!daoAddress || executingPermission) return;
    setVoteError(null);
    setExecutingPermission(true);
    try {
      if (chainKind !== 'evm') {
        setVoteError('Permission execute via governor is EVM-only in this UI.');
        return;
      }
      if (!evmChainId) {
        setVoteError('Select an Ethereum, Base, or Robinhood network.');
        return;
      }
      const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'permission');
      if (!payload?.length) {
        setVoteError(
          'Could not recover this Permission proposal payload. Execute from the device that created it, or re-submit the Permission proposal.',
        );
        return;
      }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) {
        setVoteError('EVM contracts are not configured for this network.');
        return;
      }
      const { wallets, threshold } = decodeEvmPermissionPayload(payload);
      const outcome = await tx.sendEvm(
        buildExecutePermissionProposalEvm(evmChainId, trio.governor, proposal.number, wallets, threshold),
        { successLabel: `Guardian config applied — proposal #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
      else setVoteError(outcome.error || 'Permission execution failed.');
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Permission execution failed.');
    } finally {
      setExecutingPermission(false);
    }
  }

  async function handleExecuteTreasuryTransfer() {
    if (!daoAddress || executingTransfer) return;
    setVoteError(null);
    setExecutingTransfer(true);
    try {
      if (chainKind === 'evm') {
        if (!evmChainId || !evmAddress) {
          setVoteError('Connect an EVM wallet and select Ethereum or Base.');
          return;
        }
        const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'transfer');
        if (!payload?.length) {
          setVoteError(
            'Could not recover this transfer proposal payload. The governor only stores a hash on-chain — execute from the device that created it, or create a new transfer from Treasury so the payload is re-indexed.',
          );
          return;
        }
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) {
          setVoteError('EVM contracts are not configured for this network.');
          return;
        }
        let buildResult;
        try {
          const { asset, recipient, amount } = decodeEvmTransferRequestPayload(payload);
          buildResult = buildExecuteTransferProposalEvm(evmChainId, trio.governor, proposal.number, asset, recipient, amount);
        } catch {
          const { collection, recipient, tokenId } = decodeEvmNftTransferRequestPayload(payload);
          buildResult = buildExecuteNftTransferProposalEvm(evmChainId, trio.governor, proposal.number, collection, recipient, tokenId);
        }
        const outcome = await tx.sendEvm(
          buildResult,
          { successLabel: `Treasury transfer executed — proposal #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
        else setVoteError(outcome.error || 'Transfer execution failed.');
        return;
      }

      if (!publicKey) {
        setVoteError('Connect a Solana wallet to execute.');
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const onChainProposal = await fetchProposal(daoPubkey, proposal.number);
      if (!onChainProposal) {
        setVoteError('Could not load this proposal on-chain.');
        return;
      }
      if (onChainProposal.status !== OnChainProposalStatus.Passed) {
        setVoteError('This transfer proposal has not passed yet.');
        return;
      }
      if (onChainProposal.proposalType !== OnChainProposalType.Transfer) {
        setVoteError('This is not a transfer proposal on-chain.');
        return;
      }
      const raw = await fetchProposalPayloadBytes(daoPubkey, proposal.number);
      if (!raw || raw.length < 72) {
        setVoteError('Invalid or missing transfer payload on-chain (expected 72 bytes).');
        return;
      }
      const dec = decodeSolanaTransferProposalPayload(Buffer.from(raw));
      const isNativeSol = dec.mint.equals(SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER);

      if (isNativeSol) {
        const outcome = await tx.send(
          await buildExecuteTreasuryTransferNativeSol(daoPubkey, proposal.number, publicKey, dec.recipient),
          { successLabel: `Treasury transfer executed — proposal #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
        else setVoteError(outcome.error || 'Transfer execution failed.');
        return;
      }

      if (dec.amount === 1n) {
        const { core } = getNavePrograms();
        const [nftRecordPda] = getNftVaultRecordPDA(daoPubkey, dec.mint);
        const nftRecord = await (core.account as unknown as { nftVaultRecord: { fetchNullable: (k: PublicKey) => Promise<{ transferred: boolean } | null> } })
          .nftVaultRecord.fetchNullable(nftRecordPda);
        if (nftRecord && !nftRecord.transferred) {
          const outcome = await tx.send(
            await buildExecuteTreasuryTransferNft(daoPubkey, proposal.number, publicKey, dec.mint, dec.recipient),
            { successLabel: `NFT transfer executed — proposal #${proposal.number}` },
          );
          if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
          else setVoteError(outcome.error || 'NFT transfer execution failed.');
          return;
        }
      }

      const { core } = getNavePrograms();
      const [assetCfgPda] = getAssetConfigPDA(daoPubkey, dec.mint);
      const cfg = await core.account.assetConfig.fetchNullable(assetCfgPda);
      if (cfg && !cfg.enabled) {
        setVoteError('This treasury asset is disabled on-chain.');
        return;
      }

      const outcome = await tx.send(
        await buildExecuteTreasuryTransferSpl(
          daoPubkey,
          proposal.number,
          publicKey,
          dec.mint,
          dec.recipient,
        ),
        { successLabel: `Treasury transfer executed — proposal #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
      else setVoteError(outcome.error || 'Transfer execution failed.');
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Transfer execution failed.');
    } finally {
      setExecutingTransfer(false);
    }
  }

  async function handleCreateExecutionRequest() {
    if (chainKind === 'evm') {
      if (!daoAddress || creatingReq) return;
      if (proposal.type === 'transfer') {
        setVoteError(
          'Treasury transfers no longer use the agent execution-request pipeline. After finalization, use “Execute treasury transfer” in this card instead.',
        );
        return;
      }
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, proposal.type);
      if (!payload) {
        setVoteError('Could not recover this EVM execution payload from the on-chain payload index. Queue execution from the device that created the proposal, or recreate it.');
        return;
      }
      setCreatingReq(true);
      setVoteError(null);
      try {
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) {
          setVoteError('EVM contracts are not configured for this network yet.');
          return;
        }
        const buildResult = (() => {
          let decoded: { adapter: `0x${string}`; asset: `0x${string}`; amount: bigint };
          try {
            const d = decodeEvmStrategyProposalPayload(payload);
            decoded = { adapter: d.adapter, asset: d.asset, amount: d.amount };
          } catch {
            decoded = decodeEvmStrategyRequestPayload(payload);
          }
          return buildCreateStrategyRequestEvm(
            evmChainId,
            trio.execution,
            proposal.number,
            decoded.amount,
            decoded.adapter,
            decoded.asset,
          );
        })();
        const outcome = await tx.sendEvm(buildResult, {
          successLabel: `Execution request created for proposal #${proposal.number}`,
        });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to create EVM execution request.');
        }
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to create EVM execution request.');
      } finally {
        setCreatingReq(false);
      }
      return;
    }
    if (!publicKey || !daoAddress || creatingReq) return;
    setCreatingReq(true);
    setVoteError(null);
    try {
      const amount = Number(createReqAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setVoteError('Enter a valid execution amount.');
        return;
      }
      const protocolProgram = getAdapterProgramId(createReqProtocol);
      if (!protocolProgram) {
        setVoteError(`Adapter program is not configured for ${createReqProtocol}.`);
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const [proposalPubkey] = getProposalPDA(daoPubkey, proposal.number);
      const selectedMintStr = createReqAssetMint || votingMint || NATIVE_MINT.toBase58();
      const mint = new PublicKey(selectedMintStr);
      const matchedAsset = registeredTreasuryAssets.find((a) => a.mint === selectedMintStr);
      const amountBaseUnits = matchedAsset
        ? parseUnits(createReqAmount.trim() || '1', matchedAsset.decimals)
        : BigInt(Math.floor(amount));
      const result = await buildCreateExecutionRequest(
        daoPubkey,
        proposalPubkey,
        publicKey,
        amountBaseUnits,
        protocolProgram,
        mint,
      );
      const outcome = await tx.send(result, { successLabel: `Execution request created for proposal #${proposal.number}` });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        onChanged?.();
      } else {
        setVoteError(outcome.error || 'Failed to create execution request.');
      }
    } finally {
      setCreatingReq(false);
    }
  }

  async function handleExecuteSwitchVotingSystem() {
    if (!daoAddress || executingSwitchVoting) return;
    setVoteError(null);
    setExecutingSwitchVoting(true);
    try {
      if (chainKind === 'evm') {
        if (!evmChainId) {
          setVoteError('Select an Ethereum, Base, Robinhood, or Arc network.');
          return;
        }
        const trio = await fetchDaoContracts(evmChainId, daoAddress);
        if (!trio) {
          setVoteError('EVM contracts are not configured for this network yet.');
          return;
        }
        const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'switch-voting');
        let newGovType = isTokenGov ? 0 : 1;
        let newVotingToken = newGovType === 1 && votingMint ? votingMint : '0x0000000000000000000000000000000000000000';
        if (payload?.length) {
          try {
            const dec = decodeEvmSwitchVotingPayload(payload);
            newGovType = dec.governanceType;
            newVotingToken = dec.votingToken;
          } catch { /* fall back to inferred toggle */ }
        }
        const outcome = await tx.sendEvm(
          buildExecuteSwitchVotingSystemEvm(evmChainId, trio.governor, proposal.number, newGovType, newVotingToken),
          { successLabel: `Voting system switched — proposal #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to execute voting system switch.');
        }
        return;
      }
      if (!publicKey) {
        setVoteError('Connect your Solana wallet to execute this voting system switch.');
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const outcome = await tx.send(
        await buildSwitchVotingSystem(daoPubkey, publicKey, proposal.number),
        { successLabel: `Voting system switched — proposal #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        onChanged?.();
      } else {
        setVoteError(outcome.error || 'Failed to execute voting system switch.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to execute voting system switch.');
    } finally {
      setExecutingSwitchVoting(false);
    }
  }

  const pipelineStage = getPipelineStage(proposal, gc, finalizeOpts);

  type PrimaryAction = {
    label: string;
    icon: string;
    disabled: boolean;
    loading: boolean;
    onClick: (e: React.MouseEvent) => void;
  };

  let primaryAction: PrimaryAction | null = null;

  if (pipelineStage === 'vote' && proposal.status === 'active' && !voted && isMember) {
    primaryAction = {
      label: 'Cast vote',
      icon: 'check-to-slot',
      disabled: voting,
      loading: voting,
      onClick: (e) => {
        e.stopPropagation();
        setExpanded(true);
      },
    };
  } else if (pipelineStage === 'finalize' && proposal.status === 'active' && isMember && finalizable) {
    primaryAction = {
      label: finalizing ? 'Finalizing…' : 'Finalize voting',
      icon: 'gavel',
      disabled: finalizing,
      loading: finalizing,
      onClick: (e) => {
        e.stopPropagation();
        void handleFinalize();
      },
    };
  } else if (pipelineStage === 'execute' && proposal.status === 'passed') {
    if (proposal.type === 'policy' && isFounder && !alreadyRatified && isMember) {
      primaryAction = {
        label: ratifying ? 'Ratifying…' : 'Ratify constitution',
        icon: 'scroll',
        disabled: ratifying,
        loading: ratifying,
        onClick: (e) => {
          e.stopPropagation();
          void handleRatifyConstitution();
        },
      };
    } else if (proposal.type === 'agent-enable' && isFounder && isMember) {
      primaryAction = {
        label: enabling ? 'Enabling…' : 'Execute: Enable agents',
        icon: 'play',
        disabled: enabling,
        loading: enabling,
        onClick: (e) => {
          e.stopPropagation();
          void handleExecuteEnableAgents();
        },
      };
    } else if (proposal.type === 'token-mint' && isFounder && isMember) {
      primaryAction = {
        label: ratifying ? 'Minting…' : 'Execute mint',
        icon: 'coins',
        disabled: ratifying,
        loading: ratifying,
        onClick: (e) => {
          e.stopPropagation();
          void handleRatifyTokenMint();
        },
      };
    } else if (proposal.type === 'transfer' && isMember) {
      primaryAction = {
        label: executingTransfer ? 'Executing…' : 'Execute transfer',
        icon: 'paper-plane',
        disabled: executingTransfer,
        loading: executingTransfer,
        onClick: (e) => {
          e.stopPropagation();
          void handleExecuteTreasuryTransfer();
        },
      };
    } else if (proposal.type === 'switch-voting' && isMember) {
      primaryAction = {
        label: executingSwitchVoting ? 'Switching…' : 'Execute voting system switch',
        icon: 'scale-balanced',
        disabled: executingSwitchVoting,
        loading: executingSwitchVoting,
        onClick: (e) => {
          e.stopPropagation();
          void handleExecuteSwitchVotingSystem();
        },
      };
    } else {
      primaryAction = {
        label: 'Review next steps',
        icon: 'arrow-right',
        disabled: false,
        loading: false,
        onClick: (e) => {
          e.stopPropagation();
          setExpanded(true);
        },
      };
    }
  }

  return (
    <div
      ref={cardRef}
      className="nave-card overflow-hidden"
      style={{
        borderColor: highlight || expanded ? 'hsl(var(--border-strong))' : 'hsl(var(--border))',
        boxShadow: highlight ? '0 0 0 2px hsl(var(--ring))' : undefined,
      }}
    >
      {/* Clickable summary row */}
      <button
        className="w-full text-left p-5"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Top: number + title */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <div
              className="text-display font-bold nave-mono"
              style={{ fontSize: '18px', color: 'hsl(var(--foreground))', letterSpacing: '-0.01em', lineHeight: 1 }}
            >
              #{proposal.number}
            </div>
            <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
              · {typeMeta.label}
            </span>
          </div>
          <h3
            className="text-display font-semibold"
            style={{ fontSize: '15px', color: 'hsl(var(--foreground))', lineHeight: 1.35 }}
          >
            {proposal.title}
          </h3>
          {!expanded && (
            <ProposalPayloadSummary
              proposal={proposal}
              daoAddress={daoAddress}
              chainKind={chainKind}
              evmChainId={evmChainId}
              expanded={false}
              compact
            />
          )}
        </div>

        {/* Pipeline stepper */}
        {pipelineStage !== 'complete' && (
          <div className="mb-3">
            <ProposalStatusStepper stage={pipelineStage} />
          </div>
        )}

        {/* Vote bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span style={{ fontSize: '11.5px', color: 'hsl(var(--accent-muted-foreground))' }}>For {pctFor}%</span>
              <span style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))' }}>Against {pctAgainst}%</span>
            </div>
            <span className="nave-mono" style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>
              Quorum {reqParticipation > 0 && Number.isFinite(quorumPct) ? `${quorumPct}%` : '—'}
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'hsl(var(--border))' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${pctFor}%`,
                backgroundColor: proposal.status === 'rejected' ? 'hsl(var(--destructive))' : 'hsl(var(--accent))',
              }}
            />
          </div>
        </div>

        {/* Bottom: meta on left, status badge + chevron on right */}
        <div className="flex items-center justify-between mt-3">
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
            style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)' }}
          >
            <span>{fmtVotes(proposal.totalVotes)} votes</span>
            <span>By {proposal.author}</span>
            <span>{proposal.deadline}</span>
            {myVote && (
              <span
                style={{
                  color:
                    myVote === 'for'
                      ? 'hsl(var(--accent-muted-foreground))'
                      : myVote === 'abstain'
                        ? 'hsl(var(--muted-foreground))'
                        : 'hsl(var(--destructive))',
                }}
              >
                You voted {myVote}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                fontSize: '11.5px',
                fontFamily: 'var(--font-mono)',
                color: statusMeta.color,
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: statusMeta.color }}
              />
              {statusMeta.label}
            </span>
            <Fi
              icon={expanded ? 'chevron-up' : 'chevron-down'}
              style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
            />
          </div>
        </div>
      </button>

      {charter.status && (
      <div className="px-5 pb-3">
        <CharterCheckStatus
          status={charter.status}
          summary={charter.summary}
          txId={charter.txId}
          asking={charter.asking}
          askError={charter.askError}
          onAskAnother={charter.canAsk ? (evidence) => { void charter.askAnother(evidence); } : undefined}
        />
      </div>
      )}

      {primaryAction && (
        <div className="px-5 pb-4">
          <button
            type="button"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: 'hsl(var(--primary))',
              color: 'hsl(var(--primary-foreground))',
              opacity: primaryAction.disabled ? 0.6 : 1,
            }}
          >
            <Fi
              icon={primaryAction.loading ? 'arrows-rotate' : primaryAction.icon}
              style={{ fontSize: '12px' }}
              className={primaryAction.loading ? 'animate-spin' : ''}
            />
            {primaryAction.label}
          </button>
        </div>
      )}

      {/* Inline expanded details */}
      {expanded && (
        <div
          className="border-t px-5 pb-5 pt-4 space-y-5"
          style={{ borderColor: 'hsl(var(--border))' }}
        >
          {/* Cast vote (active only) */}
          {proposal.status === 'active' && (
            <div
              className="p-4 rounded-xl border"
              style={{
                backgroundColor: voted ? 'hsl(var(--accent-muted))' : 'hsl(var(--surface-1))',
                borderColor: voted ? 'hsl(var(--border-strong))' : 'hsl(var(--border))',
              }}
            >
              {voted ? (
                <div className="flex items-center gap-2">
                  <Fi icon="circle-check" style={{ fontSize: '14px', color: 'hsl(var(--accent))' }} />
                  <span style={{ fontSize: '13px', color: 'hsl(var(--accent-muted-foreground))' }}>
                    You voted <strong>{myVote}</strong> on this proposal.
                  </span>
                </div>
              ) : (
                <div>
                  <div className="text-display font-semibold mb-3" style={{ fontSize: '13.5px' }}>Cast your vote</div>
                  {isTokenGov && (
                    <div className="mb-3">
                      <label className="nave-label" style={{ fontSize: '11.5px', color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '4px' }}>
                        Tokens to lock for this vote
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={lockAmount}
                        onChange={e => setLockAmount(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        placeholder="e.g. 1000"
                        className="w-full px-3 py-2 rounded-lg border outline-none"
                        style={{
                          fontSize: '13px',
                          fontFamily: 'var(--font-mono)',
                          backgroundColor: 'hsl(var(--surface-0))',
                          borderColor: 'hsl(var(--border))',
                          color: 'hsl(var(--foreground))',
                        }}
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={e => { e.stopPropagation(); handleVote('for'); }}
                      disabled={voting || !isMember}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border font-medium transition-all"
                      style={{
                        fontSize: '13.5px',
                        backgroundColor: myVote === 'for' ? 'hsl(var(--accent))' : 'hsl(var(--surface-0))',
                        borderColor: myVote === 'for' ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                        color: myVote === 'for' ? 'white' : 'hsl(var(--foreground))',
                        opacity: !isMember ? 0.5 : 1,
                        cursor: !isMember ? 'not-allowed' : 'pointer',
                      }}
                      title={!isMember ? 'Connect a wallet that is a member of this DAO to vote' : undefined}
                    >
                      <Fi icon="check" style={{ fontSize: '13px' }} />
                      For
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleVote('against'); }}
                      disabled={voting || !isMember}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border font-medium transition-all"
                      style={{
                        fontSize: '13.5px',
                        backgroundColor: myVote === 'against' ? 'hsl(var(--destructive))' : 'hsl(var(--surface-0))',
                        borderColor: myVote === 'against' ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
                        color: myVote === 'against' ? 'white' : 'hsl(var(--foreground))',
                        opacity: !isMember ? 0.5 : 1,
                        cursor: !isMember ? 'not-allowed' : 'pointer',
                      }}
                      title={!isMember ? 'Connect a wallet that is a member of this DAO to vote' : undefined}
                    >
                      <Fi icon="xmark" style={{ fontSize: '13px' }} />
                      Against
                    </button>
                  </div>
                  {!isMember && (
                    <div className="flex items-center gap-2 mt-3" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                      <Fi icon="lock" style={{ fontSize: '11px' }} />
                      Only treasury members can vote. Connect a member wallet or acquire the DAO token to participate.
                    </div>
                  )}
                  {voting && (
                    <div className="flex items-center gap-2 mt-3" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                      <Fi icon="arrows-rotate" style={{ fontSize: '12px' }} className="animate-spin" />
                      Submitting vote on-chain…
                    </div>
                  )}
                  {voteError && (
                    <div className="flex items-center gap-2 mt-3" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                      <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                      {voteError}
                    </div>
                  )}
                </div>
              )}

              {/* Finalize — tallies votes once the window has closed (or outcome is certain). */}
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                {isUndefeatable(proposal, guardianCount, quorumRounding) && !votingWindowClosed(proposal) && (
                  <div
                    className="flex items-center gap-1.5 mb-2 px-2 py-1.5 rounded-lg"
                    style={{ backgroundColor: 'hsl(var(--success-muted))', fontSize: '11.5px', color: 'hsl(152 50% 28%)' }}
                  >
                    <Fi icon="circle-check" style={{ fontSize: '10px' }} />
                    Outcome is mathematically certain — early finalization is available.
                  </div>
                )}
                <button
                  onClick={e => { e.stopPropagation(); handleFinalize(); }}
                  disabled={finalizing || !isMember || !finalizable}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border font-medium transition-all"
                  style={{
                    fontSize: '12.5px',
                    backgroundColor: finalizable ? 'hsl(var(--surface-1))' : 'hsl(var(--surface-0))',
                    borderColor: finalizable ? 'hsl(var(--border-strong))' : 'hsl(var(--border))',
                    color: finalizable ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                    opacity: finalizing || !isMember ? 0.6 : finalizable ? 1 : 0.5,
                    cursor: !isMember || !finalizable ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    !isMember
                      ? 'Connect a wallet that is a member of this DAO to finalize'
                      : finalizable
                        ? undefined
                        : 'Voting window is still open — waiting for more votes or window close'
                  }
                >
                  <Fi icon="gavel" style={{ fontSize: '12px' }} />
                  {finalizing
                    ? 'Finalizing…'
                    : votingWindowClosed(proposal)
                      ? 'Finalize voting'
                      : `Finalize (${proposal.deadline})`}
                </button>
                {finalizing && (
                  <div className="flex items-center gap-2 mt-2" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>
                    <Fi icon="arrows-rotate" style={{ fontSize: '11px' }} className="animate-spin" />
                    Checking on-chain state…
                  </div>
                )}
                {voteError && !voting && (
                  <div className="flex items-center gap-2 mt-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                    <Fi icon="circle-xmark" style={{ fontSize: '11px' }} />
                    {voteError}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Reclaim locked voting tokens — token governance, after voting ends */}
          {isTokenGov && proposal.status !== 'active' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                {proposal.status === 'rejected' ? 'Failed — release your escrow' : 'Reclaim Locked Tokens'}
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                {proposal.status === 'rejected'
                  ? 'This proposal did not pass (voted down or quorum was not met when it was finalized). If you locked governance tokens to vote, release them back to your wallet.'
                  : 'If you locked governance tokens to vote on this proposal, voting has now ended — you can withdraw them back to your wallet.'}
              </p>
              <button
                onClick={e => { e.stopPropagation(); handleReleaseEscrow(); }}
                disabled={releasing || !isMember || !walletStr}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border font-medium transition-all"
                style={{
                  fontSize: '12.5px',
                  borderColor: 'hsl(var(--border-strong))',
                  backgroundColor: 'hsl(var(--surface-0))',
                  color: 'hsl(var(--foreground))',
                  opacity: releasing || !isMember || !walletStr ? 0.6 : 1,
                  cursor: releasing || !isMember || !walletStr ? 'not-allowed' : 'pointer',
                }}
                title={!walletStr ? 'Connect the wallet you voted with to reclaim locked tokens' : undefined}
              >
                <Fi icon={releasing ? 'arrows-rotate' : 'lock-open'} style={{ fontSize: '11px' }} className={releasing ? 'animate-spin' : ''} />
                {releasing ? 'Reclaiming…' : 'Reclaim locked tokens'}
              </button>
              {releaseMsg && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))' }}>
                  <Fi icon="circle-check" style={{ fontSize: '12px', color: 'hsl(var(--accent))' }} />
                  {releaseMsg}
                </div>
              )}
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Ratify a passed constitution (policy) proposal — founder applies it on-chain */}
          {proposal.status === 'passed' && proposal.type === 'policy' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Ratify Constitution
              </div>
              {alreadyRatified ? (
                <div
                  className="rounded-lg overflow-hidden border"
                  style={{ borderColor: 'hsl(152 40% 70%)' }}
                >
                  <div
                    className="flex items-start gap-2 px-3 py-2.5"
                    style={{ fontSize: '12.5px', color: 'hsl(152 50% 28%)', backgroundColor: 'hsl(var(--success-muted))', lineHeight: 1.4 }}
                  >
                    <Fi icon="circle-check" style={{ fontSize: '12px', flexShrink: 0, marginTop: '1px' }} />
                    <span>
                      <strong>Constitution applied on-chain.</strong> Your agents are ready — go to the Agent page and click <strong>Propose to Enable Agents</strong> to put resuming them to a DAO vote.
                    </span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); navigate('/agent'); }}
                    className="w-full flex items-center justify-center gap-2 py-2 font-medium transition-all"
                    style={{ fontSize: '12.5px', backgroundColor: 'hsl(var(--primary))', color: 'white' }}
                  >
                    <Fi icon="scale-balanced" style={{ fontSize: '10px' }} />
                    Propose to Enable Agents →
                  </button>
                </div>
              ) : (
                <>
                  <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                    Apply this approved policy to the treasury constitution on-chain. Once ratified, go to the <strong>Agent page</strong> and click <strong>Propose to Enable Agents</strong> to put resuming them to a DAO vote, after which the agents operate under these constraints.
                  </p>
                  {isFounder ? (
                    <button
                      onClick={e => { e.stopPropagation(); handleRatifyConstitution(); }}
                      disabled={ratifying || !isMember}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                      style={{
                        fontSize: '13px',
                        backgroundColor: 'hsl(var(--primary))',
                        color: 'hsl(var(--primary-foreground))',
                        opacity: ratifying || !isMember ? 0.6 : 1,
                      }}
                    >
                      <Fi icon={ratifying ? 'arrows-rotate' : 'scroll'} style={{ fontSize: '12px' }} className={ratifying ? 'animate-spin' : ''} />
                      {ratifying ? 'Ratifying…' : 'Ratify & apply constitution'}
                    </button>
                  ) : (
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-lg"
                      style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', backgroundColor: 'hsl(var(--surface-0))' }}
                    >
                      <Fi icon="circle-info" style={{ fontSize: '11px' }} />
                      Awaiting founder ratification to apply this constitution on-chain.
                    </div>
                  )}
                </>
              )}
              {ratifyMsg && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))' }}>
                  <Fi icon="circle-check" style={{ fontSize: '12px', color: 'hsl(var(--accent))' }} />
                  {ratifyMsg}
                </div>
              )}
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Execute a passed agent-enable proposal — founder resumes the agents on-chain */}
          {proposal.status === 'passed' && proposal.type === 'agent-enable' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(152 40% 70%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Execute: Enable Agents
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                This proposal passed. Executing reconnects this DAO to the four autonomous agents (Executive, Financial, Operational, Oversight), which will resume checking the treasury for necessary actions under the current constitution.
              </p>
              {isFounder ? (
                <button
                  onClick={e => { e.stopPropagation(); handleExecuteEnableAgents(); }}
                  disabled={enabling || !isMember}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--primary))',
                    color: 'hsl(var(--primary-foreground))',
                    opacity: enabling || !isMember ? 0.6 : 1,
                  }}
                >
                  <Fi icon={enabling ? 'arrows-rotate' : 'play'} style={{ fontSize: '12px' }} className={enabling ? 'animate-spin' : ''} />
                  {enabling ? 'Enabling…' : 'Execute: Enable Agents'}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', backgroundColor: 'hsl(var(--surface-0))' }}>
                  <Fi icon="circle-info" style={{ fontSize: '11px' }} />
                  Awaiting founder to execute and resume the agents on-chain.
                </div>
              )}
              {enableMsg && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))' }}>
                  <Fi icon="circle-check" style={{ fontSize: '12px', color: 'hsl(var(--accent))' }} />
                  {enableMsg}
                </div>
              )}
              {enableError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {enableError}
                </div>
              )}
            </div>
          )}

          {/* Ratify a passed token-mint proposal — founder executes the on-chain mint */}
          {proposal.status === 'passed' && proposal.type === 'token-mint' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(38 92% 75%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Execute Token Mint
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                This proposal passed. Executing will mint the approved token amount into the treasury vault on-chain.
              </p>
              {isFounder ? (
                <button
                  onClick={e => { e.stopPropagation(); handleRatifyTokenMint(); }}
                  disabled={ratifying || !isMember}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--primary))',
                    color: 'hsl(var(--primary-foreground))',
                    opacity: ratifying || !isMember ? 0.6 : 1,
                  }}
                >
                  <Fi icon={ratifying ? 'arrows-rotate' : 'coins'} style={{ fontSize: '12px' }} className={ratifying ? 'animate-spin' : ''} />
                  {ratifying ? 'Minting…' : 'Execute Mint'}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', backgroundColor: 'hsl(var(--surface-0))' }}>
                  <Fi icon="circle-info" style={{ fontSize: '11px' }} />
                  Awaiting founder to execute this mint on-chain.
                </div>
              )}
              {ratifyMsg && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))' }}>
                  <Fi icon="circle-check" style={{ fontSize: '12px', color: 'hsl(var(--accent))' }} />
                  {ratifyMsg}
                </div>
              )}
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Passed treasury transfer — direct execution (no agent execution pipeline) */}
          {proposal.status === 'passed' && proposal.type === 'transfer' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(214 80% 80%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Execute treasury transfer
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                {chainKind === 'evm'
                  ? 'This proposal passed. The governor only stores a hash on-chain — execution needs the raw recipient/asset/amount from when the proposal was created (saved in this browser).'
                  : 'This proposal passed. Execution moves native SOL from the vault authority PDA, or SPL from the DAO asset vault to the recipient ATA in the exact amounts fixed when the proposal was created.'}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleExecuteTreasuryTransfer();
                }}
                disabled={executingTransfer || !isMember}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                  opacity: executingTransfer || !isMember ? 0.6 : 1,
                }}
              >
                <Fi icon={executingTransfer ? 'arrows-rotate' : 'paper-plane'} style={{ fontSize: '12px' }} className={executingTransfer ? 'animate-spin' : ''} />
                {executingTransfer ? 'Executing…' : 'Execute transfer'}
              </button>
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Passed Permission — apply guardian set via governor */}
          {proposal.status === 'passed' && proposal.type === 'permission' && chainKind === 'evm' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(271 80% 80%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Apply guardian config
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                Calls <code>executePermissionProposal</code>, which applies wallets + threshold through
                the treasury governor path (<code>applyGuardianConfigFromGovernor</code>).
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleExecutePermission();
                }}
                disabled={executingPermission || !isMember}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                  opacity: executingPermission || !isMember ? 0.6 : 1,
                }}
              >
                <Fi icon={executingPermission ? 'arrows-rotate' : 'shield'} style={{ fontSize: '12px' }} className={executingPermission ? 'animate-spin' : ''} />
                {executingPermission ? 'Applying…' : 'Execute permission proposal'}
              </button>
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Ratify a passed switch-voting proposal — execute the governance change on-chain */}
          {proposal.status === 'passed' && proposal.type === 'switch-voting' && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(271 80% 80%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                Apply Voting System Change
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                This proposal passed. Execute the voting system switch on-chain to transition this DAO's governance model.
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleExecuteSwitchVotingSystem();
                }}
                disabled={executingSwitchVoting || !isMember}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                style={{
                  fontSize: '13px',
                  backgroundColor: 'hsl(var(--primary))',
                  color: 'hsl(var(--primary-foreground))',
                  opacity: executingSwitchVoting || !isMember ? 0.6 : 1,
                }}
              >
                <Fi icon={executingSwitchVoting ? 'arrows-rotate' : 'scale-balanced'} style={{ fontSize: '12px' }} className={executingSwitchVoting ? 'animate-spin' : ''} />
                {executingSwitchVoting ? 'Switching…' : 'Execute voting system switch'}
              </button>
              {voteError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {voteError}
                </div>
              )}
            </div>
          )}

          {/* Halted strategy execution request recovery */}
          {haltedEr && (
            <div
              className="p-4 rounded-xl border space-y-3"
              style={{ backgroundColor: 'hsl(var(--destructive-muted))', borderColor: 'hsl(0 72% 80%)' }}
            >
              <div className="text-display font-semibold" style={{ fontSize: '13.5px', color: 'hsl(0 60% 35%)' }}>
                Execution Request Halted
              </div>
              <p style={{ fontSize: '12.5px', color: 'hsl(0 50% 35%)', lineHeight: 1.5 }}>
                {haltedEr.reason || 'This execution request is currently halted by the Oversight agent.'}
              </p>
              {isFounder && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleClearProposalHalt();
                  }}
                  disabled={clearingHalt}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-all"
                  style={{
                    fontSize: '13px',
                    backgroundColor: 'hsl(var(--primary))',
                    color: 'hsl(var(--primary-foreground))',
                    opacity: clearingHalt ? 0.6 : 1,
                  }}
                >
                  <Fi icon={clearingHalt ? 'arrows-rotate' : 'shield-check'} style={{ fontSize: '12px' }} className={clearingHalt ? 'animate-spin' : ''} />
                  {clearingHalt ? 'Clearing…' : 'Clear Halt'}
                </button>
              )}
              {clearHaltMsg && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--accent-muted-foreground))' }}>
                  <Fi icon="circle-check" style={{ fontSize: '12px', color: 'hsl(var(--accent))' }} />
                  {clearHaltMsg}
                </div>
              )}
              {clearHaltError && (
                <div className="flex items-center gap-2" style={{ fontSize: '12px', color: 'hsl(var(--destructive))' }}>
                  <Fi icon="circle-xmark" style={{ fontSize: '12px' }} />
                  {clearHaltError}
                </div>
              )}
            </div>
          )}

          {/* Strategy execution — auto-chained or manual fallback */}
          {proposal.status === 'passed' && proposal.type === 'strategy' && (
            hasStoredStrategyPayload(daoAddress, proposal.number) ? (
              <div
                className="flex items-start gap-2.5 p-4 rounded-xl border"
                style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
              >
                <Fi icon="clock" style={{ fontSize: '13px', color: 'hsl(var(--primary))', flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <div className="text-display font-semibold mb-1" style={{ fontSize: '13.5px' }}>
                    Queued for Agent Review
                  </div>
                  <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                    This strategy is queued for agent review. The approval pipeline will execute it once the review window elapses.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className="p-4 rounded-xl border space-y-3"
                style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
              >
                <div className="text-display font-semibold" style={{ fontSize: '13.5px' }}>
                  Move Passed Strategy to Execution
                </div>
                <p style={{ fontSize: '12.5px', color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>
                  Create an execution request so the agent approval pipeline can review, sign, and execute this proposal.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={createReqAmount}
                    onChange={(e) => setCreateReqAmount(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 py-2 rounded-lg border"
                    style={{
                      fontSize: '12.5px',
                      fontFamily: 'var(--font-mono)',
                      backgroundColor: 'hsl(var(--surface-0))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                  />
                  <select
                    value={createReqProtocol}
                    onChange={(e) => setCreateReqProtocol(e.target.value as 'kamino' | 'jito' | 'marginfi' | 'jupiter')}
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 py-2 rounded-lg border"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: 'hsl(var(--surface-0))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    <option value="kamino">Kamino</option>
                    <option value="jito">Jito</option>
                    <option value="jupiter">Jupiter</option>
                    {MARGINFI_STRATEGY_ENABLED && <option value="marginfi">Marginfi</option>}
                  </select>
                  <select
                    value={createReqAssetMint}
                    onChange={(e) => setCreateReqAssetMint(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 py-2 rounded-lg border"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: 'hsl(var(--surface-0))',
                      borderColor: 'hsl(var(--border))',
                      color: 'hsl(var(--foreground))',
                    }}
                  >
                    {registeredTreasuryAssets.length > 0 ? (
                      registeredTreasuryAssets.map((a) => (
                        <option key={a.mint} value={a.mint}>
                          {a.symbol}
                        </option>
                      ))
                    ) : (
                      <option value={votingMint ?? NATIVE_MINT.toBase58()}>
                        {votingMint ? `${votingMint.slice(0, 6)}…` : 'wSOL'}
                      </option>
                    )}
                  </select>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCreateExecutionRequest();
                    }}
                    disabled={creatingReq || !isMember}
                    className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg font-medium"
                    style={{
                      fontSize: '12.5px',
                      backgroundColor: 'hsl(var(--primary))',
                      color: 'hsl(var(--primary-foreground))',
                      opacity: creatingReq || !isMember ? 0.6 : 1,
                    }}
                  >
                    <Fi icon={creatingReq ? 'arrows-rotate' : 'bolt'} style={{ fontSize: '11px' }} className={creatingReq ? 'animate-spin' : ''} />
                    {creatingReq ? 'Creating…' : 'Create request'}
                  </button>
                </div>
              </div>
            )
          )}

          <ProposalPayloadSummary
            proposal={proposal}
            daoAddress={daoAddress}
            chainKind={chainKind}
            evmChainId={evmChainId}
            expanded={expanded}
          />

          {/* About (predefined per type) */}
          <div>
            <div className="text-display font-semibold mb-2" style={{ fontSize: '13.5px' }}>About</div>
            <p style={{ fontSize: '13.5px', lineHeight: 1.7, color: 'hsl(var(--muted-foreground))' }}>
              {description}
            </p>
          </div>

          {/* Author / timeline meta */}
          <div
            className="flex flex-wrap gap-4 p-4 rounded-xl border"
            style={{ backgroundColor: 'hsl(var(--surface-1))', borderColor: 'hsl(var(--border))' }}
          >
            {[
              { label: 'Author', value: proposal.author },
              { label: 'Created', value: proposal.created },
              { label: 'Deadline', value: proposal.deadline },
            ].map(m => (
              <div key={m.label}>
                <div className="nave-label" style={{ fontSize: '10px' }}>{m.label}</div>
                <div className="nave-mono mt-1" style={{ fontSize: '12.5px', color: 'hsl(var(--foreground))' }}>{m.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}