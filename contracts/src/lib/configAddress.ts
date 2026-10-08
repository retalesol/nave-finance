export const PROGRAM_IDS = {
  naveCore: "8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB",
  naveGovernance: "CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M",
  naveExecution: "2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb",
  naveJitoAdapter: "E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT",
  naveKaminoAdapter: "B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD",
  naveMarginfiAdapter: "Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7",
} as const;

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export const CONFIG_BY_CLUSTER: Record<Cluster, typeof PROGRAM_IDS> = {
  localnet: PROGRAM_IDS,
  devnet: PROGRAM_IDS,
  "mainnet-beta": PROGRAM_IDS,
};

export function getProgramIds(cluster: Cluster = "devnet") {
  return CONFIG_BY_CLUSTER[cluster];
}
