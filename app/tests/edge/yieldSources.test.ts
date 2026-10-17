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
const ARC_ADAPTER = "0x12DA47672287c188C79c1504eE72E2aC8b446f7B";
const ROBINHOOD_USDC = "0xAaaE26C5B891bF00D4cD6eF04148Bf1CB1CC96b1";
const ROBINHOOD_ADAPTER = "0x31be55dCf50a71B42948408c9eFE7004f827BF0F";
const ROBINHOOD_WETH = "0x7943e237c7F95DA44E0301572D358911207852Fa";
const ROBINHOOD_WETH_ADAPTER = "0xF16421BDD5B9D6418d3133c49f3Afc8cdf15b457";

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

test("robinhood and arc score first-party ERC-4626 vaults and cctp hops with deployed adapters and mints", () => {
  const robinhood = scoreEvmTestnetOpportunities(
    [
      { protocolId: "morpho-steakhouse-usdg", programId: "" },
      { protocolId: "robinhood-weth-vault", programId: "" },
      { protocolId: "cctp", programId: "0x0000000000000000000000000000000000000000" },
    ],
    "robinhood",
    46630,
  );
  assert.equal(robinhood.length, 3);
  assert.equal(robinhood[0].programId, ROBINHOOD_ADAPTER);
  assert.equal(robinhood[0].mint, ROBINHOOD_USDC);
  assert.equal(robinhood[0].source, "testnet-rate:morpho-steakhouse-usdg");
  assert.equal(robinhood[1].programId, ROBINHOOD_WETH_ADAPTER);
  assert.equal(robinhood[1].mint, ROBINHOOD_WETH);
  assert.equal(robinhood[1].source, "testnet-rate:robinhood-weth-vault");
  assert.match(robinhood[2].source ?? "", /testnet-rate:cctp-to-sepolia-aave-v3/);
  assert.equal(robinhood[2].mint, ROBINHOOD_USDC);
  assert.equal(JSON.stringify(robinhood).includes(ARC_USDC), false);

  const arc = scoreEvmTestnetOpportunities(
    [
      { protocolId: "morpho-steakhouse-usdc", programId: "" },
      { protocolId: "cctp", programId: "" },
    ],
    "arc",
    5042002,
  );
  assert.equal(arc.length, 2);
  assert.equal(arc[0].programId, ARC_ADAPTER);
  assert.equal(arc[0].mint, ARC_USDC);
  assert.equal(arc[0].source, "testnet-rate:morpho-steakhouse-usdc");
  assert.equal(arc[1].mint, ARC_USDC);
  assert.match(arc[1].source ?? "", /testnet-rate/);
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
