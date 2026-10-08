# Agent Fine-Tuning Readiness (Phase 7)

This documents the agent context contract, the deterministic guardrails that gate
signing, reasoning-hash integrity, the eval harness, and the go/no-go checklist
for kicking off fine-tuning. The governing principle: **the model is advisory;
signing eligibility is decided by deterministic checks and on-chain invariants.**

## 1. Agent context contract

Canonical, versioned shape fed to every agent decision:
`supabase/functions/_shared/agentContext.ts` (`AgentContext`,
`AGENT_CONTEXT_VERSION`). It covers DAO + governance type, the execution request
(action, protocol, expected payload hash, amount), treasury snapshot + age,
approved-protocol allowlist, risk params (caps, confidence threshold), prior
agent actions, and recent activity. Bump `AGENT_CONTEXT_VERSION` on any shape
change so fixtures and logged hashes stay attributable to a context version.

**Current version: `1.1.0`.** The `1.1.0` bump added the optional
`gate: { agentsEnabled, frozen }` field carrying the on-chain agent pause/freeze
state (`DaoRegistry.frozen` + `AgentSet`/`DaoRegistry.agents_enabled`). The field
is optional and absent in legacy contexts/fixtures; a flag is `null` when it could
not be read from chain. New eval fixtures carry `version: "1.1.0"` and the `gate`
field; pre-`1.1.0` fixtures (no `gate`) remain valid and the gate check treats a
missing `gate` as not-applicable (see §2).

## 2. Deterministic guardrails (the signing gate)

`supabase/functions/_shared/guardrails.ts` (`evaluateGuardrails`) runs OUTSIDE
the model, before any signing, over the `AgentContext` + the model's structured
output. Checks:

- `role_valid` — acting role is known; operational never signs.
- `agents_enabled` — on-chain agent gate. For signing roles this **fails closed**
  when `ctx.gate.frozen === true` or `ctx.gate.agentsEnabled === false` (blocks
  signing). When `ctx.gate` is absent the check is **not applicable** and never
  blocks (legacy/back-compat). The operational role is **exempt**: a closed gate
  surfaces a non-blocking warning so halt/expire monitoring keeps running while
  the DAO is frozen.
- `confidence_threshold` — confidence ≥ constitution threshold.
- `decision_consistency` — no approve-without-should_sign; no halt+clear_halt.
- `risk_severity` — no severe/constitution-violation/payload-mismatch/stale flags.
- `snapshot_freshness` — treasury snapshot within max age.
- `protocol_allowlist` — target protocol is constitution-approved.
- `allocation_cap` — `deployed + amount ≤ maxSingleAllocationBps × NAV`.
- `global_deployment_cap` — `deployed + amount ≤ maxTotalDeployedBps × NAV`.
- `liquidity_floor` — `NAV − (deployed + amount) ≥ minLiquidityBps × NAV`.
- `reserve_floor` — stablecoin reserve ≥ `minStablecoinReserveBps × NAV` (hard
  block when measurable; non-blocking warning under the single-mint vault model).
- `rebalance_interval` — forced rebalances blocked until the cadence has elapsed.
- `payload_hash_equality` — model payload hash equals the on-chain bound hash.

`shouldSign = pass && isSigning && model.should_sign`. The dispatcher uses this
to set the final signing decision; the model cannot override a guardrail failure.

### Fail-closed posture

`evaluateGuardrails` defaults to `failClosedOnUnknown: true`: a critical check
whose context is missing **fails** (blocks signing). The dispatcher now also
defaults to fail-closed — it passes `failClosedOnUnknown: true` unless the
operator explicitly sets `NAVE_GUARDRAILS_FAIL_CLOSED=false` (intended for
controlled local/dev runs only; must never be set in production). This is safe
because the orchestrator threads `expected_payload_hash` + `protocol_program` +
`target_amount` and the dispatcher reads `approved_protocols`, the per-protocol
cap, NAV/deployed, and the agent gate directly on-chain, so a fail-closed verdict
reflects genuinely missing data rather than a wiring gap.

**Mainnet gate:** keep the dispatcher at `failClosedOnUnknown: true` (i.e. do not
set `NAVE_GUARDRAILS_FAIL_CLOSED=false`) so the off-chain guardrails fully mirror
the on-chain invariants as defense-in-depth.

### Model-config seam (fine-tuned model A/B)

The dispatcher's model id is config-driven: `NAVE_AGENT_MODEL` overrides the
default (`claude-sonnet-4-6`). Whatever is configured is logged to
`agent_action_logs.claude_model` and returned as `model`. Because signing
eligibility is decided downstream by `evaluateGuardrails` over the canonical
`AgentContext` + structured output — independent of which model produced the
output — swapping in a fine-tuned model NEVER bypasses or weakens the guardrails.
This is the seam used to A/B a fine-tuned model behind a flag once the dataset and
scorecard gates below are green. (The `NAVE_AGENT_MODEL` env wiring is owned by the
model-config worker; this doc references it.)

## 3. Reasoning-hash integrity

The dispatcher computes a deterministic SHA-256 over the canonical reasoning
artifacts (`canonicalReasoning` + `computeReasoningHash`), stores it in
`agent_action_logs.reasoning_hash`, and returns it. The orchestrator forwards it
to the signer, which commits the same 32-byte hash on-chain. Drift between the
stored reasoning and the on-chain commitment is detectable by recomputation —
useful for replay, audit, and eval integrity.

## 4. Eval harness

All eval entry points are dependency-light (Node `tsx` + Deno compatible) and run
the SAME `_shared` modules the dispatcher uses, so they pin production behavior.

### 4.1 Guardrail fixtures (`npm run eval:guardrails`)

- Fixtures: `eval/fixtures/guardrails.json` — safe approval, low confidence,
  stale snapshot, insufficient data, single/global cap violations, liquidity and
  reserve floors, rebalance cadence, payload mismatch, protocol not allowed,
  severe risk flag (malicious prompt), decision contradiction, operational halt
  contradiction, **and the agent-gate cases** (`gate_frozen_blocks_signing`,
  `gate_agents_disabled_blocks_signing`, `gate_open_signs`,
  `gate_closed_operational_exempt`).
- Runner: `eval/run-guardrails.ts`. Asserts each fixture's `pass`/`shouldSign` and
  that the expected checks fail. Exit non-zero on any mismatch. Fixtures run with
  `failClosedOnUnknown: true` (the mainnet end-state).

### 4.2 Prompt-regression decision scorecard (`npm run eval:decisions`)

- Fixtures: `eval/fixtures/decisions.json`; runner: `eval/run-decisions.ts`.
- Each fixture freezes a recorded `(AgentContext + model output)` pair and asserts
  the FINAL post-guardrail **decision** the dispatcher would emit
  (`finalDecision = blocked ? "request_review" : model.decision`) plus
  `shouldSign`. This lets prompt edits be measured against golden decisions
  instead of vibes — without calling the live model in CI. When a prompt change
  alters recorded outputs, regenerate the fixtures from new traces; the harness
  pins the deterministic consequences (no silent signing-behavior drift).

### 4.3 Trace-export + offline fine-tuning scorecard

- `npm run trace:export` → `scripts/export-finetune-traces.ts` (see §7).
- `npm run eval:ft-scorecard` → `eval/run-ft-scorecard.ts` consumes an exported
  JSONL dataset (defaults to the checked-in sample
  `eval/fixtures/ft-traces.sample.jsonl`) and reports guardrail agreement rate,
  decision precision/recall/F1 vs labels, and confidence calibration buckets. It
  is offline/deterministic and supports optional `--min-agreement` / `--min-f1`
  gates for CI.

`npm run eval` runs the guardrail + decision suites together. Type-check the eval
and trace TS with `npm run typecheck:eval` (`deno check` is equivalent).

Grow fixtures from real devnet traces (`docs/DEVNET_E2E_GATE.md`): capture the
`AgentContext` + model output for notable decisions and add them as cases.

## 5. Observability

The Agent page surfaces live agent health (decision, confidence, error/guardrail
counts), the live execution pipeline, and per-action detail including
constitution checks, risk flags, payload hash, the deterministic reasoning hash,
and the on-chain signer signature (`useAgentStatus` → `ClaudeActivityLog`).

## 6. Fine-tuning go/no-go checklist

Do **not** start fine-tuning until all are green:

- [ ] Phases 0–6 complete (security, RLS, audited contract revision, custody +
      orchestrator correctness, frontend wiring, devnet E2E gate, prod hardening).
- [ ] `npm run eval:guardrails` passes; known-bad scenarios are rejected before
      signing (includes the agent-gate cases).
- [ ] `npm run eval:decisions` passes; recorded `(context, output)` pairs map to
      the golden post-guardrail decisions (prompt-regression gate).
- [ ] Dispatcher runs `failClosedOnUnknown: true` with full context threaded.
      The dispatcher defaults to fail-closed (`NAVE_GUARDRAILS_FAIL_CLOSED`
      unset/`true`) and the orchestrator threads payload hash + protocol program +
      amount with on-chain reads — confirm `NAVE_GUARDRAILS_FAIL_CLOSED=false` is
      NOT set in the target environment.
- [ ] Trace dataset + scorecard green: `npm run trace:export` produces a JSONL
      dataset and `npm run eval:ft-scorecard` over it shows guardrail
      `let-through-bad = 0` and decision metrics at the agreed thresholds (gate it
      with `--min-agreement` / `--min-f1`).
- [ ] Reconciliation invariants hold across a full gate run (`docs/RECONCILIATION.md`).
- [ ] Upgrade authority on multisig; runbooks + alerting live (`docs/RUNBOOKS.md`).

When green, kick off fine-tuning using the exported devnet/mainnet trace dataset.
Keep the model advisory: deterministic guardrails + on-chain invariants remain the
signing authority regardless of model quality. A/B the fine-tuned model via the
`NAVE_AGENT_MODEL` seam (§2) with guardrails unchanged.

## 7. Trace-export dataset (fine-tuning corpus)

`scripts/export-finetune-traces.ts` (run `npm run trace:export`) builds the
supervised dataset from the `agent_action_logs` table. It is **read-only** on the
DB (SELECT-only) and **fail-closed**: it errors cleanly unless both `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` are set. Output is JSONL (one row per model
decision) to stdout or `--out <path>`; supports `--limit <n>` and `--dao <addr>`.

Each row (`FineTuneTraceRow`, `schema_version: "ft-trace/1.1.0"`) assembles:

1. **context_signal** — the reconstructable subset of `AgentContext` available in
   the log (dao, role, action, the payload hash bound to the request, and the
   `constitution_check` the signing agent evaluated). The full `AgentContext` is
   not persisted today, so this is a subset; a future context-snapshot column can
   enrich it without changing the schema.
2. **model_output** — `decision`, `confidence`, `risk_flags`, the raw model
   response (`raw_claude_response`), and the reasoning text.
3. **guardrail_verdict** — `status` (`completed` vs `guardrail_blocked`),
   `blocked`, and the `error_message` (failure reasons when blocked).
4. **outcome** — the final on-chain result, joined from subsequent
   `signing` / `execute_strategy` / `jupiter_deposit` / `withdraw_from_strategy` /
   `halt` / `expire_request` logs for the SAME `execution_request_address`, with
   `tx_signature`s and a `terminal` state
   (`executed | signed | expired | halted | pending`).

**Outcome-based label** (also documented in the script header):

- `good` — guardrails passed AND the on-chain outcome matched the model intent
  (`approve` → executed/signed; `halt` → halted; `reject`/`request_review` →
  expired).
- `bad` — `guardrail_blocked`, OR the model approved something the chain/guardrails
  rejected (`approve` → expired/halted-for-risk), OR the decision contradicts the
  realized chain state (`reject` → executed).
- `unlabeled` — no terminal on-chain outcome yet (pending/in-review) or a decision
  with no defined expected outcome; excluded from precision/recall but retained.

The label is advisory training signal only; signing authority always remains the
deterministic guardrails + on-chain invariants.

### New env vars (for the integration/ops worker)

- `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` —
  required by `trace:export` (read-only service client; fail-closed if missing).
- `NAVE_AGENT_MODEL` — dispatcher model id A/B seam (owned by model-config worker;
  referenced here).
- `NAVE_GUARDRAILS_FAIL_CLOSED` — dispatcher fail-closed override; leave unset/
  `true` in production (owned by the dispatcher/guardrails worker; referenced here).
