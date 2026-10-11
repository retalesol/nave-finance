import assert from "node:assert/strict";
import test from "node:test";
import { daoNetworkFor, registryNetworkFor } from "../../supabase/functions/_shared/chain.ts";

test("testnet chain ids store testnet, and solana devnet stays devnet", () => {
  for (const chain_id of [11155111, 84532, 46630, 5042002]) {
    const chain = chain_id === 11155111
      ? "ethereum"
      : chain_id === 84532
        ? "base"
        : chain_id === 46630
          ? "robinhood"
          : "arc";
    assert.equal(daoNetworkFor({ chain, chain_id }, true), "testnet");
    assert.equal(registryNetworkFor({ chain, chain_id }, "mainnet", true), "testnet");
  }
  assert.equal(daoNetworkFor({ chain: "solana", chain_id: null }, false), "devnet");
  assert.equal(registryNetworkFor({ chain: "solana", chain_id: null }, "devnet", true), "devnet");
  assert.equal(registryNetworkFor({ chain: "solana", chain_id: null }, "testnet", true), "devnet");
  assert.equal(registryNetworkFor({ chain: "solana", chain_id: null }, "mainnet", true), "mainnet");
  assert.equal(registryNetworkFor({ chain: "solana", chain_id: null }, "mainnet", false), "devnet");
  assert.equal(daoNetworkFor({ chain: "base", chain_id: 8453 }, false), "mainnet");
  assert.equal(daoNetworkFor({ chain: "ethereum", chain_id: 1 }, false), "mainnet");
  assert.equal(daoNetworkFor({ chain: "robinhood", chain_id: 4663 }, false), "mainnet");
});
