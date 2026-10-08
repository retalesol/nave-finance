/** Simulated DeFi yield — adapters use escrow; tests model APY off-chain then mint harvest to vault. */

export const USDC_DECIMALS = 6;
export const MAX_APY_BPS = 1200; // 12%
export const APY_SCENARIOS_BPS = [300, 500, 800, 1000, 1200] as const;

export function usdcToRaw(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
}

export function rawToUsdc(raw: bigint): number {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

/** Compound yield: principal * (1 + apy)^(days/365) - principal */
export function simulateYield(
  principalRaw: bigint,
  annualApyBps: number,
  durationDays: number
): bigint {
  if (annualApyBps <= 0 || durationDays <= 0) return 0n;
  if (annualApyBps > MAX_APY_BPS) {
    throw new Error(`APY ${annualApyBps} bps exceeds simulated cap ${MAX_APY_BPS} bps`);
  }
  const principal = Number(principalRaw);
  const rate = annualApyBps / BPS_DENOMINATOR;
  const growth = principal * Math.pow(1 + rate, durationDays / 365);
  return BigInt(Math.floor(growth - principal));
}

const BPS_DENOMINATOR = 10_000;

export interface TreasuryGrowthSnapshot {
  label: string;
  principalUsdc: number;
  deployedUsdc: number;
  apyBps: number;
  months: number;
  simulatedYieldUsdc: number;
  totalNavUsdc: number;
}

export function projectTreasuryGrowth(
  label: string,
  principalUsdc: number,
  deployedUsdc: number,
  apyBps: number,
  months: number
): TreasuryGrowthSnapshot {
  const durationDays = months * 30;
  const yieldRaw = simulateYield(usdcToRaw(deployedUsdc), apyBps, durationDays);
  const yieldUsdc = rawToUsdc(yieldRaw);
  return {
    label,
    principalUsdc,
    deployedUsdc,
    apyBps,
    months,
    simulatedYieldUsdc: yieldUsdc,
    totalNavUsdc: principalUsdc + yieldUsdc,
  };
}

/** Split treasury across protocols respecting constitution max bps caps. */
export function allocateByCaps(
  totalNavRaw: bigint,
  capsBps: number[]
): bigint[] {
  const sum = capsBps.reduce((a, b) => a + b, 0);
  if (sum === 0) return capsBps.map(() => 0n);
  return capsBps.map((bps) => (totalNavRaw * BigInt(bps)) / BigInt(sum));
}
