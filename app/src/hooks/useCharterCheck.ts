import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChain } from './useChain';
import { supabase } from '../lib/supabaseClient';
import { normalizeDaoOnchainAddressForQuery } from '../lib/chain/daoOnchainAddress';
import { isEvmChainId, isEvmTestnet, evmTarget, type ChainFamily } from '../lib/chain/types';
import { SOLANA_NETWORK } from '../lib/programConfig';
import { askForAnotherCheck } from '../lib/edgeFunctionClient';
import {
  counterevidenceError,
  isActionHash,
  normalizeActionHash,
  screenStatus,
  type CustomerStatus,
  type GenNetwork,
} from '../../supabase/functions/_shared/genlayerCharter.ts';

interface ReviewRow {
  decision: string | null;
  finished: boolean | null;
  provisional: boolean | null;
  summary: string | null;
  tx_id: string | null;
  action_hash: string | null;
  customer_status: string | null;
}

function reviewNetwork(family: ChainFamily, evmChainId: number | null): GenNetwork {
  if (family === 'solana') return SOLANA_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
  if (evmChainId != null && isEvmChainId(evmChainId) && isEvmTestnet(evmChainId)) return 'testnet';
  return 'mainnet';
}

function familyFor(
  treasury: string,
  daoChainId: number | null | undefined,
  walletFamily: ChainFamily,
): ChainFamily {
  if (typeof daoChainId === 'number' && isEvmChainId(daoChainId)) return evmTarget(daoChainId).family;
  if (treasury && !/^0x/i.test(treasury.trim())) return 'solana';
  return walletFamily;
}

export function useCharterCheck(
  treasury: string | null | undefined,
  daoChainId?: number | null,
  actionHash?: string | null,
) {
  const { chainFamily: walletFamily, evmChainId } = useChain();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const treasuryKey = normalizeDaoOnchainAddressForQuery(treasury);
  const chainFamily = familyFor(treasuryKey, daoChainId, walletFamily);
  const network = reviewNetwork(
    chainFamily,
    chainFamily === 'solana' ? null : (typeof daoChainId === 'number' && isEvmChainId(daoChainId) ? daoChainId : evmChainId),
  );
  const boundHash = isActionHash(actionHash) ? normalizeActionHash(actionHash ?? '') : '';

  const query = useQuery({
    queryKey: ['genlayer-charter', treasuryKey, chainFamily, network, boundHash],
    enabled: treasuryKey.length > 0 && boundHash.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<ReviewRow | null> => {
      const { data, error } = await supabase
        .from('genlayer_reviews')
        .select('decision, finished, provisional, summary, tx_id, action_hash, customer_status')
        .eq('treasury', treasuryKey)
        .eq('chain_family', chainFamily)
        .eq('network', network)
        .eq('kind', 'charter')
        .eq('action_hash', boundHash)
        .maybeSingle();
      if (error) return null;
      const row = (data as ReviewRow | null) ?? null;
      if (row && !isActionHash(row.action_hash)) return null;
      if (row?.action_hash && normalizeActionHash(row.action_hash) !== boundHash) return null;
      return row;
    },
  });

  const row = query.data ?? null;
  const status: CustomerStatus | null = screenStatus(row);
  const canAsk = isActionHash(row?.action_hash) && normalizeActionHash(row?.action_hash ?? '') === boundHash;

  async function askAnother(counterevidence: string) {
    if (!treasuryKey || asking || !canAsk || !row?.action_hash) return;
    const rejected = counterevidenceError(counterevidence);
    if (rejected) {
      setAskError(rejected);
      return;
    }
    setAsking(true);
    setAskError(null);
    try {
      const result = await askForAnotherCheck({
        chain_family: chainFamily,
        network,
        treasury: treasuryKey,
        action_hash: normalizeActionHash(row.action_hash),
        pause_reason: 'Reviewers asked for another look at this move.',
        counterevidence: counterevidence.trim(),
      });
      if (result.error) setAskError(result.error);
      await queryClient.invalidateQueries({ queryKey: ['genlayer-charter', treasuryKey, chainFamily, network, boundHash] });
    } finally {
      setAsking(false);
    }
  }

  return {
    status,
    summary: row?.summary ?? '',
    txId: row?.tx_id ?? '',
    asking,
    askError,
    canAsk,
    askAnother,
  };
}
