import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { fetchAllProposals } from '../lib/onChainFetcher';
import { fetchProposalsEvm } from '../lib/evm/readers';
import { isProgramConfigured } from '../lib/programConfig';
import { chainKindFromAddress, type EvmChainId } from '../lib/chain/types';
import { useChain } from './useChain';
import { ProposalStatus } from '../lib/onChainTypes';
import type { Proposal, ProposalType } from '../lib/onChainTypes';
import { isMockDaoAddress, MOCK_PROPOSALS } from '../lib/mockData';
import { getProposalPDA } from '../lib/pdaDerivation';

export interface ProposalInfo {
  index: number;
  proposer: string;
  proposalType: ProposalType;
  title: string;
  description: string;
  votesFor: number;
  votesAgainst: number;
  voterCount: number;
  status: ProposalStatus;
  voteTokenMint: string;
  snapshotSlot: number;
  snapshotSupply: number;
  quorumBps: number;
  threshold: number;
  votingEnd: number;
  createdAt: number;
  executedAt: number;
  payloadHash: string;
  archived: boolean;
  pda: string;
}

interface UseProposalsResult {
  proposals: ProposalInfo[];
  activeProposals: ProposalInfo[];
  passedProposals: ProposalInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

async function fetchProposalsData(
  daoAddress: string,
  proposalCount: number,
  evmChainId: EvmChainId | null,
): Promise<ProposalInfo[]> {
  // EVM DAOs (0x…): enumerate governor proposals via the EVM reader.
  if (chainKindFromAddress(daoAddress) === 'evm') {
    if (!evmChainId) return [];
    return proposalCount > 0 ? fetchProposalsEvm(evmChainId, daoAddress, proposalCount) : [];
  }

  if (!isProgramConfigured() || proposalCount === 0) {
    return [];
  }

  const daoPubkey = new PublicKey(daoAddress);
  const rawProposals = await fetchAllProposals(daoPubkey, proposalCount);

  return rawProposals
    .filter((p): p is Proposal => {
      if (p === null) return false;
      if (p.dao && p.dao !== daoAddress) {
        console.warn(
          '[useProposals] Skipping proposal whose on-chain dao field does not match active treasury:',
          { expected: daoAddress, got: p.dao, index: p.index },
        );
        return false;
      }
      return true;
    })
    .map((p) => ({
      index: p.index,
      proposer: p.proposer,
      proposalType: p.proposalType,
      title: p.title,
      description: p.description,
      votesFor: p.votesFor,
      votesAgainst: p.votesAgainst,
      voterCount: p.voterCount,
      status: p.status,
      voteTokenMint: p.voteTokenMint,
      snapshotSlot: p.snapshotSlot,
      snapshotSupply: p.snapshotSupply,
      quorumBps: p.quorumBps,
      threshold: p.threshold,
      votingEnd: p.votingEnd,
      createdAt: p.createdAt,
      executedAt: p.executedAt,
      payloadHash: p.payloadHash,
      archived: p.archived,
      pda: getProposalPDA(daoPubkey, p.index)[0].toBase58(),
    }));
}

/**
 * DAO proposals, backed by React Query so the governance page and any other
 * consumers of the same `(daoAddress, proposalCount)` share one cached fetch
 * instead of each mount re-issuing the full batch of proposal RPC reads.
 */
export function useProposals(
  daoAddress: string | null,
  proposalCount: number,
): UseProposalsResult {
  const isMock = isMockDaoAddress(daoAddress);
  const { evmChainId } = useChain();

  const query = useQuery({
    queryKey: ['proposals', daoAddress, proposalCount, evmChainId],
    queryFn: () => fetchProposalsData(daoAddress as string, proposalCount, evmChainId),
    enabled: !!daoAddress && !isMock,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (isMock) {
    const mockActive = MOCK_PROPOSALS.filter(p => p.status === ProposalStatus.Active);
    const mockPassed = MOCK_PROPOSALS.filter(p => p.status === ProposalStatus.Passed);
    return {
      proposals: MOCK_PROPOSALS,
      activeProposals: mockActive,
      passedProposals: mockPassed,
      loading: false,
      error: null,
      refetch: () => {},
    };
  }

  const proposals = daoAddress ? query.data ?? [] : [];
  const activeProposals = proposals.filter((p) => p.status === ProposalStatus.Active);
  const passedProposals = proposals.filter((p) => p.status === ProposalStatus.Passed);

  if (!daoAddress) {
    return { proposals: [], activeProposals: [], passedProposals: [], loading: false, error: null, refetch };
  }

  return {
    proposals,
    activeProposals,
    passedProposals,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch proposals') : null,
    refetch,
  };
}
