/** Closed Solana mainnet nave_bridge. The same pubkey is still the devnet program. */
export const CLOSED_MAINNET_BRIDGE_PROGRAM_ID = 'Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6';

/**
 * True when a relay would target the closed mainnet bridge. Devnet keeps that
 * program id and must still be allowed.
 */
export function refusesClosedMainnetBridge(programId: string, rpcUrl: string): boolean {
  const id = programId.trim();
  const rpc = rpcUrl.trim().toLowerCase();
  const mainnet = rpc.includes('mainnet') && !rpc.includes('devnet');
  return mainnet && id === CLOSED_MAINNET_BRIDGE_PROGRAM_ID;
}

/**
 * Pure comparison for the wNAVE mint supply guard.
 * Outstanding wrapped supply (all chains that share the destination network)
 * plus the mint about to be issued must not exceed NAVE sitting in Solana custody.
 */
export function wnaveMintWouldExceedCustody(
  outstandingRaw: bigint,
  mintRaw: bigint,
  custodyRaw: bigint,
): boolean {
  if (outstandingRaw < 0n || mintRaw < 0n || custodyRaw < 0n) return true;
  return outstandingRaw + mintRaw > custodyRaw;
}
