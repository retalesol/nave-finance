import assert from "node:assert/strict";
import test from "node:test";
import { scoreEvmTestnetOpportunities } from "../../supabase/functions/_shared/yieldSources.ts";

const SEPOLIA_AAVE = "0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426";
const SEPOLIA_COMPOUND = "0x845d8310A861A95Ed1644643D1BAe086944B1AA0";
const BASE_SEPOLIA_AAVE = "0x33D19799EBac88FFDc4e5BF61c199c71963470A6";
const CURRENT_BASE_PROTOCOL = "0xF37271a4A120eD904543bbE648D2f64Fa27b3bC6";
const STALE_AAVE = "0x536e2EB2f96fe419a893CDbE39E41e44326E60dA";
const OLDER_AAVE = "0x9Fe38D5fe9804c07823b36b4ab16a0e5a7118Ebf";
const ARC_USDC = "0x3600000000000000000000000000000000000000";

test("sepolia scores aave v3 and compound v3 as testnet rates", () => {
  const scored = scoreEvmTestnetOpportunities(
    [
      { protocolId: "aave", programId: SEPOLIA_AAVE },
      { protocolId: "compound", programId: SEPOLIA_COMPOUND },
      { protocolId: "balancer", programId: "0x0000000000000000000000000000000000000000" },
    ],
    "ethereum",
    11155111,
  );
  assert.deepEqual(scored.map((row) => row.source), ["testnet-rate:aave-v3", "testnet-rate:compound-v3"]);
  assert.equal(scored.every((row) => row.liquid), true);
  assert.equal(scored.some((row) => row.source.includes("live")), false);
});

test("base sepolia aave uses the current adapter and rejects the stale ones", () => {
  for (const programId of [STALE_AAVE, OLDER_AAVE]) {
    const scored = scoreEvmTestnetOpportunities(
      [{ protocolId: "aave-v3", programId }],
      "base",
      84532,
    );
    assert.equal(scored.length, 1);
    assert.equal(scored[0].programId, "");
    assert.equal(scored[0].liquid, false);
    assert.match(scored[0].source ?? "", /testnet-rate:unavailable/);
    assert.match(scored[0].source ?? "", new RegExp(CURRENT_BASE_PROTOCOL));
    const dumped = JSON.stringify(scored);
    assert.equal(dumped.toLowerCase().includes(STALE_AAVE.toLowerCase()), false);
    assert.equal(dumped.toLowerCase().includes(OLDER_AAVE.toLowerCase()), false);
  }
  const current = scoreEvmTestnetOpportunities(
    [{ protocolId: "aave", programId: "" }],
    "base",
    84532,
  );
  assert.equal(current[0].source, "testnet-rate:aave-v3");
  assert.equal(current[0].liquid, true);
  assert.equal(current[0].programId, BASE_SEPOLIA_AAVE);
});

test("robinhood and arc score a cctp hop to sepolia aave, without a robinhood usdc address", () => {
  const robinhood = scoreEvmTestnetOpportunities(
    [{ protocolId: "cctp", programId: "0x0000000000000000000000000000000000000000" }],
    "robinhood",
    46630,
  );
  assert.equal(robinhood.length, 1);
  assert.match(robinhood[0].source ?? "", /testnet-rate:cctp-to-sepolia-aave-v3/);
  assert.equal(robinhood[0].mint, undefined);
  assert.equal(JSON.stringify(robinhood).includes(ARC_USDC), false);

  const arc = scoreEvmTestnetOpportunities(
    [{ protocolId: "cctp", programId: "" }],
    "arc",
    5042002,
  );
  assert.equal(arc.length, 1);
  assert.equal(arc[0].mint, ARC_USDC);
  assert.match(arc[0].source ?? "", /testnet-rate/);
});

test("mainnet evm chain ids are not given testnet rates", () => {
  assert.deepEqual(
    scoreEvmTestnetOpportunities([{ protocolId: "aave", programId: SEPOLIA_AAVE }], "ethereum", 1),
    [],
  );
  assert.deepEqual(
    scoreEvmTestnetOpportunities([{ protocolId: "aave", programId: "" }], "base", 8453),
    [],
  );
  assert.deepEqual(
    scoreEvmTestnetOpportunities([{ protocolId: "cctp", programId: "" }], "arc", 5042),
    [],
  );
});
