// Isolated Pyth PriceUpdateV2 poster. Posts a fresh price update for the given
// feed id(s) to the configured cluster and prints the resulting account pubkey
// as `PRICE_UPDATE_ACCOUNT=<feedHex>:<pubkey>` lines on stdout.
//
// Usage:
//   WALLET=/abs/path/wallet.json RPC=https://api.devnet.solana.com \
//     node post.mjs 0xef0d8b6f...   [0x<feed2> ...]
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
  const walletPath = process.env.WALLET;
  if (!walletPath) throw new Error("WALLET env required");

  const connection = createPosterConnection(rpc);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  const wallet = new Wallet(kp);

  const hermes = new HermesClient("https://hermes.pyth.network");
  const updates = await hermes.getLatestPriceUpdates(feeds, { encoding: "base64" });

  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(updates.binary.data);

  const accounts = feeds.map((f) => [f, builder.getPriceUpdateAccount(f)]);
  // tightComputeBudget sums CUs exactly; PostUpdate can exceed the estimate and
  // leave no room for the trailing setComputeUnitLimit ix (devnet flake).
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: false,
  });
  await receiver.provider.sendAll(txs);

  for (const [feed, acc] of accounts) {
    process.stdout.write(`PRICE_UPDATE_ACCOUNT=${feed}:${acc.toBase58()}\n`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("POST FAILED:", e?.message || e);
    process.exit(1);
  }
);
