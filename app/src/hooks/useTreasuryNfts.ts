import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { getVaultAuthorityPDA, getNftVaultRecordPDA } from '../lib/pdaDerivation';
import { getNavePrograms } from '../lib/naveProgram';
import { chainKindFromAddress } from '../lib/chain/types';
import { isMockDaoAddress } from '../lib/mockData';

export interface TreasuryNft {
  /** Mint (Solana) or `collection:tokenId` (EVM). */
  id: string;
  mint: string;
  name: string;
  collection: string;
  image: string | null;
  /** True for compressed NFTs (Bubblegum) — sends require the cNFT path. */
  compressed: boolean;
  /** True when `register_nft_asset` has been called for this mint. */
  registered: boolean;
}

interface UseTreasuryNftsResult {
  nfts: TreasuryNft[];
  loading: boolean;
  error: string | null;
  /** True when the data source (DAS) is unavailable, so an empty list is "unknown" not "none". */
  unsupported: boolean;
  refetch: () => void;
}

interface DasAsset {
  id: string;
  compression?: { compressed?: boolean };
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  interface?: string;
}

interface TreasuryNftsData {
  nfts: TreasuryNft[];
  unsupported: boolean;
}

async function fetchTreasuryNftsData(daoAddress: string, rpcEndpoint: string): Promise<TreasuryNftsData> {
  if (chainKindFromAddress(daoAddress) === 'evm') {
    return { nfts: [], unsupported: true };
  }

  const [vaultAuthority] = getVaultAuthorityPDA(new PublicKey(daoAddress));
  const res = await fetch(rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nave-nfts',
      method: 'getAssetsByOwner',
      params: { ownerAddress: vaultAuthority.toBase58(), page: 1, limit: 200 },
    }),
  });
  const json = await res.json();
  if (json.error || !json.result) return { nfts: [], unsupported: true };
  const items: DasAsset[] = json.result.items ?? [];
  const { core } = getNavePrograms();
  const daoPk = new PublicKey(daoAddress);
  const mapped: TreasuryNft[] = await Promise.all(
    items
      .filter((a) => a.interface !== 'FungibleToken' && a.interface !== 'FungibleAsset')
      .map(async (a) => {
        const collection = a.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? '';
        const image = a.content?.links?.image
          ?? a.content?.files?.[0]?.cdn_uri
          ?? a.content?.files?.[0]?.uri
          ?? null;
        let registered = false;
        try {
          const mintPk = new PublicKey(a.id);
          const [recordPda] = getNftVaultRecordPDA(daoPk, mintPk);
          const record = await (core.account as unknown as { nftVaultRecord: { fetchNullable: (k: PublicKey) => Promise<{ transferred: boolean } | null> } })
            .nftVaultRecord.fetchNullable(recordPda);
          registered = !!record && !record.transferred;
        } catch {
          registered = false;
        }
        return {
          id: a.id,
          mint: a.id,
          name: a.content?.metadata?.name || `${a.id.slice(0, 4)}…${a.id.slice(-4)}`,
          collection,
          image,
          compressed: a.compression?.compressed === true,
          registered,
        };
      }),
  );
  return { nfts: mapped, unsupported: false };
}

/**
 * Treasury-held NFTs. Solana: enumerated via the DAS `getAssetsByOwner` method
 * (Helius/Triton RPCs) over the DAO `vault_authority` PDA — covers both standard
 * Metaplex NFTs and compressed (Bubblegum) cNFTs. The RPC must support DAS; when
 * it does not, `unsupported` is set so the UI can explain the empty state rather
 * than implying the treasury holds none.
 *
 * EVM held-NFT enumeration is intentionally unsupported: the treasury can
 * custody ERC-721/1155 (receive hooks + governance transfer) but there is no
 * on-chain NFT registry (EIP-170 budget). Document as custody-only — no gallery
 * until an off-chain indexer is productized. The EVM path returns empty +
 * unsupported so the UI explains the empty state rather than implying the
 * treasury holds none.
 *
 * Backed by React Query so repeated mounts for the same DAO share one cached
 * fetch instead of each re-issuing the DAS RPC call.
 */
export function useTreasuryNfts(daoAddress: string | null): UseTreasuryNftsResult {
  const { connection } = useConnection();
  const rpcEndpoint = connection.rpcEndpoint;
  const isMock = isMockDaoAddress(daoAddress);

  const query = useQuery({
    queryKey: ['treasuryNfts', daoAddress, rpcEndpoint],
    queryFn: () => fetchTreasuryNftsData(daoAddress as string, rpcEndpoint),
    enabled: !!daoAddress && !isMock,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  if (!daoAddress || isMock) {
    return { nfts: [], loading: false, error: null, unsupported: false, refetch };
  }

  return {
    nfts: query.data?.nfts ?? [],
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : 'Failed to fetch NFTs') : null,
    unsupported: query.data?.unsupported ?? query.isError,
    refetch,
  };
}
