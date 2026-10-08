// Pyth pull-oracle price poster for the signer-service.
//
// Posts (or re-cranks) a STABLE per-(shard, feed) "price feed account" — a
// PriceUpdateV2-format PDA owned by the Pyth receiver — so on-chain consumers
// (nave_core::revalue_treasury, the Kamino refresh_reserve oracle slot) can pin
// the address in config/state and read a fresh price across calls.
//
// This mirrors contracts/solana/tools/pyth-poster/post-persistent.mjs but is
// importable from the signer so the off-chain pipeline no longer depends on the
// isolated CLI tool. The signer-service has no jito-ts dependency, so the
// rpc-websockets clash that forced the tool to be isolated does not apply here.
import { Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import { HermesClient } from '@pythnetwork/hermes-client';

const HERMES_URL = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';
const SHARD = Number(process.env.PYTH_PRICE_FEED_SHARD || '0');

/** Normalize a feed id to the `0x`-prefixed lowercase hex Hermes expects. */
function normalizeFeed(feedHex: string): string {
  const clean = feedHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`pyth feed id must be 32 bytes of hex, got "${feedHex}"`);
  }
  return `0x${clean}`;
}

/**
 * Post fresh Hermes price updates to persistent price-feed accounts and return
 * a map of (normalized 0x-feed-hex) -> PriceUpdateV2 account address.
 *
 * The accounts are deterministic PDAs (per shard + feed), created on first use
 * and re-cranked thereafter, so the returned addresses are stable across calls
 * and safe to reference from on-chain config.
 *
 * @param connection  RPC connection.
 * @param payer       Keypair that signs + pays the (tiny) crank transaction.
 * @param feedHexes   32-byte Pyth feed ids (hex, with or without 0x prefix).
 */
export async function postPriceFeeds(
  connection: Connection,
  payer: Keypair,
  feedHexes: string[],
): Promise<Map<string, PublicKey>> {
  const out = new Map<string, PublicKey>();
  const feeds = Array.from(new Set(feedHexes.map(normalizeFeed)));
  if (feeds.length === 0) return out;

  const hermes = new HermesClient(HERMES_URL);
  const updates = await hermes.getLatestPriceUpdates(feeds, { encoding: 'base64' });

  const wallet = new Wallet(payer);
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(updates.binary.data, SHARD);

  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: Number(process.env.PYTH_CU_PRICE_MICROLAMPORTS || '50000'),
    tightComputeBudget: true,
  });
  await receiver.provider.sendAll(txs);

  for (const feed of feeds) {
    out.set(feed, receiver.getPriceFeedAccountAddress(SHARD, feed));
  }
  return out;
}

/** Convert a 32-byte feed-id array (from AssetConfig.pythFeedId) to 0x hex. */
export function feedBytesToHex(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes);
  if (arr.length !== 32) throw new Error(`feed id must be 32 bytes, got ${arr.length}`);
  return `0x${arr.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** True when a 32-byte feed id is all zeroes (stablecoin / no Pyth feed). */
export function isZeroFeed(bytes: number[] | Uint8Array): boolean {
  return Array.from(bytes).every((b) => b === 0);
}
