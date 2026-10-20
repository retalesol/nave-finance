/** Simple yield outlook from a blended APY and the principal it applies to. */

export interface ProjectedYield {
  daily: number;
  weekly: number;
  annual: number;
}

export function projectedYieldFromApy(principalUsd: number, apyPercent: number): ProjectedYield {
  const annual = principalUsd * (apyPercent / 100);
  return {
    daily: annual / 365,
    weekly: annual / 52,
    annual,
  };
}

export function formatProjectedUsd(amount: number): string {
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
