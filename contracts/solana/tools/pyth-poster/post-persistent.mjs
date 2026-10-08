// Persistent Pyth price-feed-account poster. Unlike post.mjs (ephemeral
// PriceUpdateV2 per call), this cranks a STABLE per-(shard, feed) price feed
// account (a PriceUpdateV2-format PDA owned by the receiver) so an external
// program (klend) can pin it in config and read a fresh price across calls.
//
// Usage:
//   WALLET=/abs/wallet.json RPC=https://api.devnet.solana.com SHARD=0 \
//     node post-persistent.mjs 0xef0d8b6f...
// Prints `PRICE_FEED_ACCOUNT=<feedHex>:<pubkey>` for each feed.
import fs from "fs";
import anchorPkg from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import { createPosterConnection } from "./polling-confirm.mjs";

const { Wallet } = anchorPkg;

async function main() {
  const feeds = process.argv.slice(2);
  if (feeds.length === 0) throw new Error("pass at least one feed id");
  const rpc = process.env.RPC || "https://api.devnet.solana.com";
  const shard = parseInt(process.env.SHARD || "0", 10);
  const walletPath = process.env.WALLET;
  if (!walletPath) throw new Error("WALLET env required");

  const connection = createPosterConnection(rpc);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  const wallet = new Wallet(kp);

  const hermes = new HermesClient("https://hermes.pyth.network");
  const updates = await hermes.getLatestPriceUpdates(feeds, { encoding: "base64" });

  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  // Persistent price feed account(s) — created if missing, updated if present.
  await builder.addUpdatePriceFeed(updates.binary.data, shard);

  const accounts = feeds.map((f) => [f, receiver.getPriceFeedAccountAddress(shard, f)]);
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: false,
  });
  await receiver.provider.sendAll(txs);

  for (const [feed, acc] of accounts) {
    process.stdout.write(`PRICE_FEED_ACCOUNT=${feed}:${acc.toBase58()}\n`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("POST FAILED:", e?.message || e);
    process.exit(1);
  }
);
