// Cluster / Jupiter program-id guard shared by edge functions.
//
// Mirrors signer-service/src/programs.ts: when the deployment targets Solana
// mainnet, the Jupiter lending/liquidity program ids MUST be the canonical
// mainnet values. A mainnet edge function still carrying the devnet placeholder
// ids would map/route capital movements against the wrong program, so we fail
// closed rather than proceed.

/** Canonical Jupiter mainnet program ids (the ONLY acceptable values on mainnet). */
export const JUPITER_MAINNET_PROGRAM_IDS = {
  lending: "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
  liquidity: "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
} as const;

/** Devnet placeholder defaults that must NEVER be used on mainnet. */
export const JUPITER_DEVNET_DEFAULTS = {
  lending: "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3",
  liquidity: "5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL",
} as const;

/**
 * Whether this function targets Solana mainnet. Prefers the explicit
 * NAVE_CLUSTER signal (mainnet | mainnet-beta | devnet | localnet); falls back
 * to sniffing SOLANA_RPC_URL only when NAVE_CLUSTER is unset.
 */
export function isMainnetCluster(): boolean {
  const cluster = (Deno.env.get("NAVE_CLUSTER") ?? "").toLowerCase().trim();
  if (cluster) return cluster === "mainnet" || cluster === "mainnet-beta";
  return (Deno.env.get("SOLANA_RPC_URL") ?? "").includes("mainnet");
}

export interface JupiterIdCheck {
  isMainnet: boolean;
  lending: string;
  liquidity: string;
  ok: boolean;
  errors: string[];
}

/** Resolve + validate the configured Jupiter ids for the active cluster. */
export function checkJupiterProgramIds(): JupiterIdCheck {
  const isMainnet = isMainnetCluster();
  const lending = Deno.env.get("JUPITER_LENDING_PROGRAM_ID") ??
    JUPITER_DEVNET_DEFAULTS.lending;
  const liquidity = Deno.env.get("JUPITER_LIQUIDITY_PROGRAM_ID") ??
    JUPITER_DEVNET_DEFAULTS.liquidity;
  const errors: string[] = [];
  if (isMainnet) {
    if (lending !== JUPITER_MAINNET_PROGRAM_IDS.lending) {
      errors.push(
        `JUPITER_LENDING_PROGRAM_ID is ${lending}; mainnet requires ${JUPITER_MAINNET_PROGRAM_IDS.lending}`,
      );
    }
    if (liquidity !== JUPITER_MAINNET_PROGRAM_IDS.liquidity) {
      errors.push(
        `JUPITER_LIQUIDITY_PROGRAM_ID is ${liquidity}; mainnet requires ${JUPITER_MAINNET_PROGRAM_IDS.liquidity}`,
      );
    }
  }
  return { isMainnet, lending, liquidity, ok: errors.length === 0, errors };
}

/**
 * Fail-closed assertion: throws when on mainnet with non-mainnet Jupiter ids.
 * Call at the top of any handler that can drive Jupiter capital movement.
 */
export function assertJupiterMainnetConfig(): void {
  const check = checkJupiterProgramIds();
  if (!check.ok) {
    throw new Error(
      `Jupiter program id mismatch on mainnet: ${check.errors.join("; ")}`,
    );
  }
}
