// Pure classification + log contract for capital action rows.
//
// Kept free of chain/Deno imports so Node unit tests can import it directly.
// A capital log must carry the guardrail check list. `{}` and a metadata-only
// object (for example `{ compound: true }`) are empty.

export type ActionClass = "capital" | "accounting" | "control" | "other";

const CAPITAL = new Set([
  "compound",
  "execute_strategy",
  "execute_strategy_direct",
  "jupiter_deposit",
  "withdraw_from_strategy",
  "bundle_rebalance",
]);

const ACCOUNTING = new Set([
  "update_strategy_position_value",
  "revalue_treasury",
]);

const CONTROL = new Set([
  "halt",
  "operational_halt",
  "clear_halt",
  "operational_clear",
  "expire_request",
]);

export function classifyAction(action: string): ActionClass {
  const name = action.trim().toLowerCase();
  if (ACCOUNTING.has(name)) return "accounting";
  if (CONTROL.has(name)) return "control";
  if (CAPITAL.has(name) || name.includes("deposit")) return "capital";
  return "other";
}

export function isCapitalAction(action: string): boolean {
  return classifyAction(action) === "capital";
}

/** True when a persisted constitution_check has no check list. */
export function isEmptyConstitutionCheck(check: unknown): boolean {
  if (!check || typeof check !== "object" || Array.isArray(check)) return true;
  const checks = (check as Record<string, unknown>).checks;
  return !Array.isArray(checks) || checks.length === 0;
}

/**
 * Refuse to persist a capital action whose constitution_check is empty.
 * Accounting, control, and other actions are not subject to this rule.
 */
export function assertCapitalLogHasConstitution(
  actionType: string,
  constitutionCheck: unknown,
): void {
  if (!isCapitalAction(actionType)) return;
  if (isEmptyConstitutionCheck(constitutionCheck)) {
    throw new Error(
      `capital action '${actionType}' cannot be logged with an empty constitution_check`,
    );
  }
}

/** Merge a signer verdict into the row and enforce the capital-log rule. */
export function persistedConstitutionCheck(
  actionType: string,
  check: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    check && typeof check === "object" && !Array.isArray(check)
      ? { ...(check as Record<string, unknown>) }
      : {};
  const merged = extra ? { ...base, ...extra } : base;
  assertCapitalLogHasConstitution(actionType, merged);
  return merged;
}
