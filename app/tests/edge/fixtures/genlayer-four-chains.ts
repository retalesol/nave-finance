// Same action judged on Solana, Ethereum, Base, and Robinhood.
// The customer status and the guardrail block must match. No mainnet transaction.

export const SAME_ACTION_HASH = "abc123";

export const FOUR_CHAIN_CASES = [
  { chain_family: "solana" as const, network: "devnet" as const, treasury: "TreasurySame111111111111111111111111111111" },
  { chain_family: "ethereum" as const, network: "testnet" as const, treasury: "0x1111111111111111111111111111111111111111" },
  { chain_family: "base" as const, network: "testnet" as const, treasury: "0x2222222222222222222222222222222222222222" },
  { chain_family: "robinhood" as const, network: "testnet" as const, treasury: "0x3333333333333333333333333333333333333333" },
];

export const FINISHED_PASS = {
  decision: "pass" as const,
  rule_ids: [] as string[],
  summary: "",
  finished: true,
  provisional: false,
  action_hash: SAME_ACTION_HASH,
};

export const FAILED_CHECK = {
  decision: "fail" as const,
  rule_ids: ["venue_limit"],
  summary: "This would put more into one venue than your limit allows",
  finished: true,
  provisional: false,
  action_hash: SAME_ACTION_HASH,
};

export const PROVISIONAL_ACCEPT = {
  decision: "pass" as const,
  rule_ids: [] as string[],
  summary: "",
  finished: false,
  provisional: true,
  action_hash: SAME_ACTION_HASH,
};
