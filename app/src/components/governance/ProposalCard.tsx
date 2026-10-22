import { useState, useEffect, useRef } from 'react';
import { findVenue, packSolanaAllocation } from '../../../supabase/functions/_shared/strategyCatalog.ts';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useAccount, useSignMessage } from 'wagmi';
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
import { isTreasuryOpsFamily } from '@/lib/chain/types';
import { fetchDaoContracts, fetchExecutionRequestsEvm } from '@/lib/evm/readers';
import { NaveTreasuryAbi } from '@/lib/evm/contracts';
import { wagmiConfig } from '@/lib/evm/wagmi';
import { fundExecutiveGas } from '@/lib/createDaoActivationEvm';
import { ensureWalletOnChain } from '@/lib/evm/ensureWalletChain';
import {
  buildApproveErc20Evm,
  buildCastVoteEvm,
  buildExecuteTransferProposalEvm,
  buildExecuteNftTransferProposalEvm,
  buildExecutePermissionProposalEvm,
  buildExecuteSwitchVotingSystemEvm,
  decodeEvmNftTransferRequestPayload,
  decodeEvmPermissionPayload,
  decodeEvmSwitchVotingPayload,
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
import { fetchProposal, fetchProposalPayload, fetchProposalPayloadBytes, fetchExecutionRequest } from '@/lib/onChainFetcher';
import {
  decodeConstitutionPayload,
  decodeEvmTokenMintPayload,
  decodeEvmTransferRequestPayload,
  rebalanceLabelToSeconds,
} from '@/lib/constitutionPayload';
import { isMockDaoAddress } from '@/lib/mockData';
import {
  getAdapterProgramId,
  getEvmAdapterAddress,
  isConfiguredEvmAdapterAddress,
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
  requiredParticipationVotes,
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
} from './proposalStorage';
import {
  isAlreadyVotedError,
  formatVoteSubmissionError,
  formatFinalizeWindowError,
  classifyFinalizeSimulationError,
  formatFinalizeSubmissionError,
} from './voteActionHelpers';
import { ProposalVoteFinalizePanel, ProposalEscrowPanel } from './ProposalVoteFinalizePanel';
import { ProposalExecutePanels } from './ProposalExecutePanels';

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
  const charter = useCharterCheck(daoAddress, chainId, proposal.actionHash);
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
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
          setVoteError('Could not recover this token-mint payload. Please execute from the device that created it.');
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
          { successLabel: `Tokens minted — proposal #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          setRatifyMsg('Tokens minted on-chain. The updated supply is visible on the Tokens page.');
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to mint tokens on-chain.');
        }
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to mint tokens.');
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
      const onChainProposal = await fetchProposal(daoPubkey, proposal.number);
      if (!onChainProposal) {
        setVoteError('Could not load this proposal on-chain to verify it passed.');
        return;
      }
      if (onChainProposal.status !== OnChainProposalStatus.Passed) {
        setVoteError('This proposal has not passed yet.');
        return;
      }
      if (onChainProposal.proposalType !== OnChainProposalType.TokenMint) {
        setVoteError('This proposal is not a token-mint proposal.');
        return;
      }
      const raw = await fetchProposalPayloadBytes(daoPubkey, proposal.number);
      if (!raw || raw.length < 72) {
        setVoteError('This proposal does not carry a valid token-mint payload.');
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
        { successLabel: `Tokens minted — proposal #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        setRatifyMsg('Tokens minted on-chain. The updated supply is visible on the Tokens page.');
        onChanged?.();
      } else {
        setVoteError(outcome.error || 'Failed to mint tokens on-chain.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to mint tokens.');
    } finally {
      setRatifying(false);
    }
  }

  async function handleExecuteEnableAgents() {
    if (!daoAddress || enabling) return;
    if (chainKind === 'evm') {
      if (!evmChainId || !isTreasuryOpsFamily(chainFamily)) {
        setEnableError('Select an Ethereum, Base, Robinhood, or Arc network.');
        return;
      }
      if (!evmAddress) {
        setEnableError('Connect your EVM founder wallet to resume the agents.');
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
        const { data, error } = await setAgentsEnabledViaProxyEvm(
          daoAddress,
          evmAddress,
          (m) => signMessageAsync({ message: m }),
          true,
          evmChainId,
          chainFamily,
        );
        if (error || !data?.success) {
          setEnableError(error || data?.error || 'Failed to resume agents on-chain.');
          return;
        }
        setEnableMsg('Agents resumed. The four specialists will begin checking this treasury on the next cycle.');
        onChanged?.();
      } catch (err) {
        setEnableError(err instanceof Error ? err.message : 'Failed to resume agents on-chain.');
      } finally {
        setEnabling(false);
      }
      return;
    }
    if (!publicKey) {
      setEnableError('Connect your founder wallet to resume the agents.');
      return;
    }
    if (!signMessage) {
      setEnableError('Your wallet does not support message signing.');
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
        setEnableError(error || data?.error || 'Failed to resume agents on-chain.');
        return;
      }
      setEnableMsg('Agents resumed. The four specialists will begin checking this treasury on the next cycle.');
      onChanged?.();
    } catch (err) {
      setEnableError(err instanceof Error ? err.message : 'Failed to resume agents on-chain.');
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
          setVoteError('Could not recover this rules payload. Activate from the device that created it.');
          return;
        }
        const decoded = decodeConstitutionPayload(payload);
        if (!decoded) {
          setVoteError('This proposal does not carry a decodable rules payload.');
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
            `Adapter addresses are not configured for: ${missingAdapters.map((p) => p.id).join(', ')}.`,
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
          setVoteError('This rules proposal has no changes to apply.');
          return;
        }
        const outcome = await tx.sendEvm(evmResults, {
          successLabel: `Rules activated — agents now follow decision #${proposal.number}`,
        });
        if (outcome.status === 'success' || outcome.status === 'mock') {
          if (ratifyStorageKey) localStorage.setItem(ratifyStorageKey, 'true');
          setAlreadyRatified(true);
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to activate rules on-chain.');
        }
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : 'Failed to activate rules.');
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
        setVoteError('This proposal does not carry a decodable rules payload.');
        return;
      }
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
        successLabel: `Rules activated — agents now follow decision #${proposal.number}`,
      });
      if (outcome.status === 'success' || outcome.status === 'mock') {
        if (ratifyStorageKey) localStorage.setItem(ratifyStorageKey, 'true');
        setAlreadyRatified(true);
        onChanged?.();
        if (signMessage) {
          void dispatchViaProxy(daoAddress, publicKey.toBase58(), (m) => signMessage(m)).then(
            ({ error }) => {
              if (error) console.warn('[governance] post-ratify orchestrator poll:', error);
            },
          );
        }
      } else {
        setVoteError(outcome.error || 'Failed to activate rules on-chain.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to activate rules.');
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
  const gc = guardianCount ?? 0;
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
    if (isMockDaoAddress(daoAddress)) {
      setMyVote(vote);
      setVoting(true);
      setTimeout(() => { setVoting(false); setVoted(true); }, 800);
      return;
    }

    if (chainKind === 'evm') {
      if (!evmChainId) { setVoteError('Select an Ethereum or Base network.'); return; }
      const trio = await fetchDaoContracts(evmChainId, daoAddress);
      if (!trio) { setVoteError('EVM contracts are not configured for this network yet.'); return; }
      const evmChoice = vote === 'for' ? 0 : 1;
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
        { successLabel: `Vote cast — ${vote === 'for' ? 'in favour' : 'against'}`, quietMock: true },
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

    let result;
    if (isTokenGov) {
      if (!votingMint) {
        setVoteError('This DAO has no voting token configured.');
        return;
      }
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
      successLabel: `Vote cast — ${vote === 'for' ? 'in favour' : 'against'}`,
      quietMock: true,
    });

    setVoting(false);
    if (outcome.status === 'mock' || outcome.status === 'success') {
      setVoted(true);
      if (walletStr && daoAddress) persistVote(daoAddress, walletStr, proposal.id, vote);
      onChanged?.();
    } else {
      const rawErr = outcome.error || 'Vote submission failed.';
      const errLower = rawErr.toLowerCase();

      const isAlreadyVoted = isAlreadyVotedError(errLower);

      if (isAlreadyVoted) {
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
          { successLabel: `Decision #${proposal.number} finalized` },
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

    if (!canFinalize(proposal, guardianCount)) {
      setVoteError(formatFinalizeWindowError(proposal.votingEndTimestamp));
      return;
    }

    setFinalizing(true);
    try {
      const daoPubkey = new PublicKey(daoAddress);
      const result = await buildFinalizeProposal(daoPubkey, proposal.number, publicKey);

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

            const simMsg = classifyFinalizeSimulationError(errorLine);
            if (simMsg) {
              setFinalizing(false);
              setVoteError(simMsg);
              return;
            }
          }
        } catch (simErr) {
          console.warn('[finalize simulation] exception:', simErr);
          setVoteError(
            'Pre-flight simulation failed — proceeding with transaction anyway. ' +
            'Review carefully in your wallet before approving.',
          );
        }
      }

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
              successLabel: `Decision #${proposal.number} finalized and queued for agents`,
            });
            if (bundledOutcome.status === 'success' || bundledOutcome.status === 'mock') {
              if (walletStr && daoAddress) clearPersistedVote(daoAddress, walletStr, proposal.id);
              onChanged?.();
            } else {
              setVoteError(formatFinalizeSubmissionError(bundledOutcome.error || 'Finalize failed.'));
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

      const outcome = await tx.send(result, { successLabel: `Decision #${proposal.number} finalized` });
      if (outcome.status === 'success' || outcome.status === 'mock') {
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

  async function handleReleaseEscrow() {
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
        setVoteError('Member updates via governor are EVM-only in this UI.');
        return;
      }
      if (!evmChainId) {
        setVoteError('Select an Ethereum, Base, or Robinhood network.');
        return;
      }
      const payload = await resolveEvmProposalPayload(daoAddress, evmChainId, proposal.number, 'permission');
      if (!payload?.length) {
        setVoteError('Could not recover this member update payload. Execute from the device that created it.');
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
        { successLabel: `Members updated — decision #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
      else setVoteError(outcome.error || 'Failed to update members.');
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to update members.');
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
            'Could not recover this payment payload. Send the payment from the device that created it.',
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
          { successLabel: `Payment sent — decision #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
        else setVoteError(outcome.error || 'Payment failed.');
        return;
      }

      if (!publicKey) {
        setVoteError('Connect a Solana wallet to send this payment.');
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const onChainProposal = await fetchProposal(daoPubkey, proposal.number);
      if (!onChainProposal) {
        setVoteError('Could not load this decision on-chain.');
        return;
      }
      if (onChainProposal.status !== OnChainProposalStatus.Passed) {
        setVoteError('This payment decision has not passed yet.');
        return;
      }
      if (onChainProposal.proposalType !== OnChainProposalType.Transfer) {
        setVoteError('This is not a payment decision on-chain.');
        return;
      }
      const raw = await fetchProposalPayloadBytes(daoPubkey, proposal.number);
      if (!raw || raw.length < 72) {
        setVoteError('Invalid or missing payment details on-chain.');
        return;
      }
      const dec = decodeSolanaTransferProposalPayload(Buffer.from(raw));
      const isNativeSol = dec.mint.equals(SOLANA_NATIVE_TRANSFER_MINT_PLACEHOLDER);

      if (isNativeSol) {
        const outcome = await tx.send(
          await buildExecuteTreasuryTransferNativeSol(daoPubkey, proposal.number, publicKey, dec.recipient),
          { successLabel: `Payment sent — decision #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
        else setVoteError(outcome.error || 'Payment failed.');
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
            { successLabel: `NFT sent — decision #${proposal.number}` },
          );
          if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
          else setVoteError(outcome.error || 'NFT transfer failed.');
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
        { successLabel: `Payment sent — decision #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') onChanged?.();
      else setVoteError(outcome.error || 'Payment failed.');
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setExecutingTransfer(false);
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
          { successLabel: `Voting system updated — decision #${proposal.number}` },
        );
        if (outcome.status === 'success' || outcome.status === 'mock') {
          onChanged?.();
        } else {
          setVoteError(outcome.error || 'Failed to update voting system.');
        }
        return;
      }
      if (!publicKey) {
        setVoteError('Connect your Solana wallet to update the voting system.');
        return;
      }
      const daoPubkey = new PublicKey(daoAddress);
      const outcome = await tx.send(
        await buildSwitchVotingSystem(daoPubkey, publicKey, proposal.number),
        { successLabel: `Voting system updated — decision #${proposal.number}` },
      );
      if (outcome.status === 'success' || outcome.status === 'mock') {
        onChanged?.();
      } else {
        setVoteError(outcome.error || 'Failed to update voting system.');
      }
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to update voting system.');
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
      label: 'Vote in favour',
      icon: 'check-to-slot',
      disabled: voting,
      loading: voting,
      onClick: (e) => {
        e.stopPropagation();
        if (isTokenGov) {
          setExpanded(true);
        } else {
          void handleVote('for');
        }
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
        label: ratifying ? 'Activating…' : 'Activate new rules',
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
        label: enabling ? 'Resuming…' : 'Resume agents',
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
        label: ratifying ? 'Minting…' : 'Mint approved tokens',
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
        label: executingTransfer ? 'Sending…' : 'Send approved payment',
        icon: 'paper-plane',
        disabled: executingTransfer,
        loading: executingTransfer,
        onClick: (e) => {
          e.stopPropagation();
          void handleExecuteTreasuryTransfer();
        },
      };
    } else if (proposal.type === 'permission' && isMember && chainKind === 'evm') {
      primaryAction = {
        label: executingPermission ? 'Updating…' : 'Update members',
        icon: 'shield',
        disabled: executingPermission,
        loading: executingPermission,
        onClick: (e) => {
          e.stopPropagation();
          void handleExecutePermission();
        },
      };
    } else if (proposal.type === 'switch-voting' && isMember) {
      primaryAction = {
        label: executingSwitchVoting ? 'Updating…' : 'Update voting system',
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
        label: 'Details',
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
      style={{
        padding: '18px 0',
        borderBottom: '1px solid hsl(var(--surface-2))',
        boxShadow: highlight ? 'inset 2px 0 0 0 hsl(var(--brass))' : undefined,
        paddingLeft: highlight ? '12px' : undefined,
      }}
    >
      {/* Clickable summary row */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
        className="w-full text-left cursor-pointer group"
      >
        {/* Top: title + status pill */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className="group-hover:text-brass transition-colors"
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '15px',
                  fontWeight: 600,
                  margin: 0,
                  lineHeight: 1.4,
                  color: 'hsl(var(--foreground))',
                }}
              >
                {proposal.title}
              </h3>
              <span
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: statusMeta.color,
                  whiteSpace: 'nowrap',
                }}
              >
                {proposal.status === 'active' ? proposal.deadline : statusMeta.label}
              </span>
            </div>

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

          <div className="flex items-center gap-2 flex-shrink-0 pt-0.5">
            <span
              className="nave-mono"
              style={{ fontSize: '11.5px', color: 'hsl(var(--faint))' }}
            >
              #{proposal.number} · {typeMeta.label}
            </span>
            <Fi
              icon={expanded ? 'chevron-up' : 'chevron-down'}
              style={{ fontSize: '11px', color: 'hsl(var(--faint))' }}
            />
          </div>
        </div>

        {/* Thin ink progress meter */}
        <div
          style={{
            height: '5px',
            backgroundColor: 'hsl(var(--surface-2))',
            borderRadius: '99px',
            overflow: 'hidden',
            marginTop: '10px',
            maxWidth: '420px',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pctFor}%`,
              backgroundColor:
                proposal.status === 'rejected'
                  ? 'hsl(var(--destructive))'
                  : '#111827',
              borderRadius: '99px',
            }}
          />
        </div>

        {/* Vote meta line */}
        <div
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2"
          style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}
        >
          <span>{pctFor}% in favour</span>
          <span>·</span>
          <span>{fmtVotes(proposal.totalVotes)} votes</span>
          {reqParticipation > 0 && Number.isFinite(quorumPct) && (
            <>
              <span>·</span>
              <span>Quorum {quorumPct}%</span>
            </>
          )}
          <span>·</span>
          <span>By {proposal.author}</span>
          {myVote && (
            <>
              <span>·</span>
              <span
                style={{
                  fontWeight: 600,
                  color:
                    myVote === 'for'
                      ? '#2F7D4F'
                      : myVote === 'abstain'
                        ? 'hsl(var(--muted-foreground))'
                        : 'hsl(var(--destructive))',
                }}
              >
                You voted {myVote === 'for' ? 'in favour' : myVote}
              </span>
            </>
          )}
        </div>
      </div>

      {charter.status && (
        <div className="mt-3">
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

      {!expanded && primaryAction && (
        <div className="flex flex-wrap items-center gap-2 mt-3.5">
          <button
            type="button"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-[9px] font-semibold transition-all"
            style={{
              fontSize: '13px',
              backgroundColor: '#111827',
              color: '#ffffff',
              opacity: primaryAction.disabled ? 0.6 : 1,
            }}
          >
            <Fi
              icon={primaryAction.loading ? 'arrows-rotate' : primaryAction.icon}
              style={{ fontSize: '11px' }}
              className={primaryAction.loading ? 'animate-spin' : ''}
            />
            {primaryAction.label}
          </button>
          {pipelineStage === 'vote' && proposal.status === 'active' && !voted && isMember && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (isTokenGov) {
                  setExpanded(true);
                } else {
                  void handleVote('against');
                }
              }}
              disabled={voting}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-[9px] border font-semibold transition-all"
              style={{
                fontSize: '13px',
                backgroundColor: '#ffffff',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--foreground))',
                opacity: voting ? 0.6 : 1,
              }}
            >
              Vote against
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            className="px-3 py-2 rounded-[9px] transition-colors"
            style={{ fontSize: '13px', fontWeight: 500, color: 'hsl(var(--muted-foreground))' }}
          >
            Details
          </button>
        </div>
      )}

      {/* Inline expanded details */}
      {expanded && (
        <div className="mt-4 pt-3 space-y-4">
          {pipelineStage !== 'complete' && (
            <div>
              <ProposalStatusStepper stage={pipelineStage} />
            </div>
          )}

          {/* Cast vote (active only) */}
          {proposal.status === 'active' && (
            <ProposalVoteFinalizePanel
              proposal={proposal}
              voted={voted}
              myVote={myVote}
              isTokenGov={isTokenGov}
              lockAmount={lockAmount}
              setLockAmount={setLockAmount}
              voting={voting}
              isMember={isMember}
              voteError={voteError}
              guardianCount={guardianCount}
              quorumRounding={quorumRounding}
              finalizing={finalizing}
              finalizable={finalizable}
              onVote={(vote) => void handleVote(vote)}
              onFinalize={() => void handleFinalize()}
            />
          )}

          {/* Reclaim locked voting tokens — token governance, after voting ends */}
          {isTokenGov && proposal.status !== 'active' && (
            <ProposalEscrowPanel
              proposalStatus={proposal.status}
              releasing={releasing}
              isMember={isMember}
              walletStr={walletStr}
              releaseMsg={releaseMsg}
              voteError={voteError}
              onReleaseEscrow={() => void handleReleaseEscrow()}
            />
          )}

          <ProposalExecutePanels
            proposal={proposal}
            chainKind={chainKind}
            isFounder={isFounder}
            isMember={isMember}
            alreadyRatified={alreadyRatified}
            ratifying={ratifying}
            ratifyMsg={ratifyMsg}
            enabling={enabling}
            enableMsg={enableMsg}
            enableError={enableError}
            executingTransfer={executingTransfer}
            executingPermission={executingPermission}
            executingSwitchVoting={executingSwitchVoting}
            haltedEr={haltedEr}
            clearingHalt={clearingHalt}
            clearHaltMsg={clearHaltMsg}
            clearHaltError={clearHaltError}
            voteError={voteError}
            onRatifyConstitution={() => void handleRatifyConstitution()}
            onExecuteEnableAgents={() => void handleExecuteEnableAgents()}
            onRatifyTokenMint={() => void handleRatifyTokenMint()}
            onExecuteTreasuryTransfer={() => void handleExecuteTreasuryTransfer()}
            onExecutePermission={() => void handleExecutePermission()}
            onExecuteSwitchVotingSystem={() => void handleExecuteSwitchVotingSystem()}
            onClearProposalHalt={() => void handleClearProposalHalt()}
          />

          <ProposalPayloadSummary
            proposal={proposal}
            daoAddress={daoAddress}
            chainKind={chainKind}
            evmChainId={evmChainId}
            expanded={expanded}
          />

          {/* About (predefined per type) */}
          <div>
            <div className="nave-label" style={{ marginBottom: '4px' }}>About</div>
            <p style={{ fontSize: '13px', lineHeight: 1.65, color: 'hsl(var(--muted-foreground))', margin: 0 }}>
              {description}
            </p>
          </div>

          {/* Author / timeline meta */}
          <div
            className="flex flex-wrap gap-6 pt-3 border-t"
            style={{ borderColor: 'hsl(var(--surface-2))' }}
          >
            {[
              { label: 'Author', value: proposal.author },
              { label: 'Created', value: proposal.created },
              { label: 'Deadline', value: proposal.deadline },
            ].map((m) => (
              <div key={m.label}>
                <div className="nave-label" style={{ fontSize: '9.5px' }}>{m.label}</div>
                <div className="nave-mono mt-0.5" style={{ fontSize: '12px', color: 'hsl(var(--foreground))' }}>{m.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
