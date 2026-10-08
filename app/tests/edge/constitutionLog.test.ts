import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCapitalLogHasConstitution,
  isCapitalAction,
  persistedConstitutionCheck,
} from "../../supabase/functions/_shared/constitutionLog.ts";

const CAPITAL = [
  "execute_strategy",
  "execute_strategy_direct",
  "jupiter_deposit",
  "withdraw_from_strategy",
  "bundle_rebalance",
  "compound",
];

test("capital log with empty constitution_check fails", () => {
  for (const action of CAPITAL) {
    assert.equal(isCapitalAction(action), true);
    assert.throws(
      () => assertCapitalLogHasConstitution(action, {}),
      /empty constitution_check/,
    );
    assert.throws(() => assertCapitalLogHasConstitution(action, null));
    assert.throws(() => persistedConstitutionCheck(action, { compound: true, protocol_id: "aave" }));
  }

  assert.doesNotThrow(() =>
    persistedConstitutionCheck("execute_strategy", {
      action_class: "capital",
      pass: false,
      checks: [{ id: "global_deployment_cap", ok: false, detail: "over cap" }],
    }),
  );
  assert.doesNotThrow(() => assertCapitalLogHasConstitution("revalue_treasury", {}));
  assert.doesNotThrow(() => assertCapitalLogHasConstitution("halt", {}));
  assert.doesNotThrow(() => assertCapitalLogHasConstitution("signing", {}));
});
