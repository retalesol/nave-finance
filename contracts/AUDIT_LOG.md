# Nave Bridge + Stake — Audit Log

Second-pass audit of the cross-chain bridge + staking system, building on
`docs/BRIDGE_STAKING_E2E_AUDIT.md`. Every finding below was re-verified against
the current code (2026-07-08), not carried forward on trust. Each entry lists
**severity / location / description / root cause / fix / covering test**.

Scope of this pass: Solana `nave_bridge` + `nave_staking`, EVM `WrappedNave` /
`NaveBridge` / `NaveStaking`, and the signer-service relayer / mirror / watcher.
Fixes here are code + test only; anything requiring an on-chain action, key
material, fund/authority movement, or a product decision is marked **OPERATOR
DECISION** and is NOT executed (per the task's safety constraints).

## Severity ranking

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| P1 | **Critical** | Single key is `owner == relayer == rewarder == upgrade authority` on all chains | **OPERATOR DECISION** (mainnet authority split) |
| K1 | **High** | Relayer/owner private keys held as raw env secrets (no KMS/HSM) | **OPERATOR DECISION** (infra) |
| M1 | Medium | Push-only relay had no auto-recovery for a lost/failed leg | **Fixed** (watcher) |
| M2 | Medium | Fee-bps defined in 3 places could drift | **Fixed** (runtime guard + invariant tests) |
| M3 | Medium | Daily cap allows up to ~2x nominal across a window boundary | **Accepted, bounded + tested** |
| L1 | Low | EVM staking `rewardRate` integer truncation leaves dust | **Fixed/mitigated** (`sweepDust` + fuzz bounds) |
| L2 | Low | `WrappedNave` ownership was single-step | **Fixed** (two-step, in code) |
| L3 | Low | `supabase-js` realtime WS needs modern Node | **OPERATOR DECISION** (runtime pin) |
| L4 | Low | Solana→EVM pre-flight balance check gated on NET, not GROSS (m13) | **Fixed** (frontend) |
| I1 | Info | Replay PDA now binds `source_chain_id` (P6 hardening) | **Fixed/verified** |
| I2 | Info | `mint ≤ locked` is not globally enforced on-chain (per-chain `supplyCap` only) | **Documented invariant** |
| I3 | Info | `WrappedNave.burnFrom` is dead in the lockbox deployment | **Documented** |
| I4 | Info | Stale comment claimed public path never re-executes | **Fixed** (comment corrected) |
| I5 | Info | Drip clock advances even at zero stake | **Documented, harmless** |

---

## Design confirmation (requested)

**Fee split — CONFIRMED matches intent.** `nave_bridge/src/constants.rs`:
`DEFAULT_FEE_BPS=250` (2.5% on top of net), split
`DEFAULT_STAKING_BPS=100` (1%, → staking pool) / `DEFAULT_PROTOCOL_BPS=100`
(1%, → protocol/treasury) / `DEFAULT_BURN_BPS=50` (0.5%, auto-burn). This is
exactly the intended "2.5% = 0.5 burn / 1 treasury / 1 staking". `fees.rs`
charges the fee ON TOP (`gross = net + fee`) and lets the **protocol/treasury
leg absorb integer-division dust** so `staking + protocol + burn == fee`
exactly, with no value created or destroyed. Owner-set fees are bounded by
`MAX_FEE_BPS=1000` and the config writer enforces
`staking_bps + protocol_bps + burn_bps == fee_bps`.
Covering tests: `programs/nave_bridge/src/fees.rs` unit + property tests
(`splits_2_5_percent_on_top`, `legs_sum_to_fee_for_many_amounts`,
`burn_leg_is_exact_and_matches_smoke`, `overflow_is_rejected_not_wrapped`,
`protocol_absorbs_combined_truncation_dust`).

**Supply invariants.**
- *Burn reduces supply — CONFIRMED.* Solana burn leg is a real SPL
  `token::burn` from custody (`lib.rs` `distribute_fee`), reducing mint supply;
  EVM `WrappedNave.burn`/`bridgeBurn` reduce `totalSupply`.
- *`mint ≤ locked` — NOT globally enforced on-chain (I2).* wNAVE is minted only
  by the lockbox on a verified Solana lock and is bounded per-chain by
  `WrappedNave.supplyCap` + the bridge per-tx/daily caps, but there is no
  on-chain assertion that Σ(wNAVE minted across chains) ≤ NAVE in Solana custody.
  Backing is preserved by construction (mint happens only after a lock is
  finalized) and is an **operational invariant** the operator must monitor
  (Σ per-chain `supplyCap` ≤ custody).
- *500K total supply* is a **tokenomics/mint-authority policy**, not something the
  bridge or staking programs hardcode or enforce. These programs never mint NAVE;
  they move, lock, and burn an existing SPL supply. Enforcing 500K is the SPL
  mint-authority's responsibility (OPERATOR DECISION / out of this code's scope).

**Fee-share staking is a SEPARATE pool — CONFIRMED, as required to report.**
`nave_staking` is a single flexible MasterChef (`acc_reward_per_share` @1e12) +
Synthetix rolling 365-day drip pool. It has **no tiers and no lock durations**
and is **NOT coupled to `nave_core`'s DaoStakeLock**. Bridge-fee rewards ride on
this standalone pool (funded via the 1% staking leg + the staking mirror), NOT
on DAO tier locks. This is by design; flagged here per instructions rather than
"resolved".

---

## Findings (detail)

### P1 — Critical — Single authority across owner/relayer/rewarder/upgrade  ·  OPERATOR DECISION
- **Location:** `solana/deployments/devnet.json` (`bridgeV2`),
  EVM deployment records; enforced-by `nave_bridge`/`nave_staking` `owner`+`relayer`,
  EVM `owner`/`relayer`/`rewarder`.
- **Description:** On devnet/testnet a single key is simultaneously the admin
  (`owner`), the hot relayer (release/`bridgeIn`), the reward notifier
  (`rewarder`), and the program upgrade authority. A compromise of that one key
  compromises everything the caps allow, and can also change caps/pause/upgrade.
- **Root cause:** Convenience of a single deploy key on testnet; not yet split.
- **Fix (recommended, NOT executed — requires on-chain authority moves):**
  Before mainnet, separate duties: cold multisig (Squads) as `owner` + program
  upgrade authority; a dedicated, rotatable hot key as `relayer`; a distinct key
  as `rewarder`. The two-step ownership handoff (already implemented on all
  contracts) is the mechanism. This is a fund/authority-moving, on-chain action —
  deferred to the operator and surfaced in the mainnet cutover preflight.
- **Covering test:** separation-of-duties is exercised in
  `evm/test/BridgeE2E.t.sol` (non-owner/non-relayer reverts) and in
  `solana/tests/bridge-staking-localnet.ts` (owner-only setters,
  two-step ownership). The mainnet split itself is verified by the cutover
  preflight (owned by another workstream), not by these unit suites.

### K1 — High — Relayer/owner keys are raw env secrets (no KMS/HSM)  ·  OPERATOR DECISION
- **Location:** `nave-app/signer-service/src/*` (key loading from env).
- **Description:** The relayer/rewarder signing keys are loaded from process env,
  so any process/host compromise or log leak exposes them.
- **Root cause:** No secrets-manager/HSM integration yet.
- **Fix (recommended, NOT executed — infra decision):** move signing to a
  KMS/HSM or a dedicated signer with least-privilege and key rotation; scope caps
  tightly so a hot-key compromise is bounded (the on-chain caps already bound
  blast radius — see M3). Deferred to the operator.
- **Covering test:** n/a (infra). Blast-radius bounding is covered by the cap
  fuzz tests (`BridgeSupplyFuzz.t.sol`).

### M1 — Medium — Push-only relay lacked auto-recovery  ·  Fixed
- **Location:** `nave-app/signer-service/src/bridgeWatcher.ts`,
  `worker.ts`.
- **Description:** If the browser's `POST /bridge-relay` was lost or the
  destination leg failed after the source lock/burn, funds were already
  committed on-chain but nothing re-drove the payout.
- **Root cause:** Single push path with no independent reconciler.
- **Fix:** independent `runBridgeWatcher` = `retrySweep` (re-drives non-completed
  rows, bounded by `retry_count < DEFAULT_MAX_BRIDGE_RETRIES`, then parks as
  `stuck`) + `missedEventScan` (scans BridgeLock/BridgeBurnTo events with no DB
  row and enqueues them). Safe against double-spend because the on-chain replay
  guards make any duplicate destination leg revert, and the recipient is always
  taken from the on-chain event. Runs under a cross-replica DB lease in
  `worker.ts`.
- **Covering test:** `bridgeWatcher.integration.test.ts` (retry of failed/pending,
  missed-event pickup, idempotency).

### M2 — Medium — Fee-bps could drift across three definitions  ·  Fixed
- **Location:** `nave_bridge/src/constants.rs` (on-chain), signer-service
  `BRIDGE_FEE_BPS` env, frontend display.
- **Description:** The 2.5% fee is expressed in three places; independent edits
  could desync display/accounting from the on-chain truth.
- **Root cause:** Duplicated constant with no cross-check.
- **Fix:** `checkBridgeFeeBpsDrift` (startup, `bridgeRelayer.ts` +
  `bridgePrograms.decodeBridgeConfigFees`) reads the on-chain `fee_bps` and warns
  loudly on mismatch with env; the on-chain split identity is enforced by
  `fees.rs` and its property tests, so on-chain is the single source of truth.
- **Covering test:** `feeBpsDrift.test.ts` (drift detection);
  `nave_bridge/src/fees.rs` property tests (split identity).

### M3 — Medium — Daily cap allows up to ~2x nominal across a boundary  ·  Accepted (bounded + tested)
- **Location:** `nave_bridge` release cap logic; `NaveBridge.sol` `dailyCap`.
- **Description:** A window-based daily cap can pass ~cap just before the window
  rolls and ~cap just after, admitting up to ~2x nominal over a short span.
- **Root cause:** Windowed accounting (any windowed scheme has a boundary).
- **Assessment / mitigation (accepted):** blast radius is hard-bounded — the
  per-tx cap is an absolute ceiling per call, and the ≤2x-over-boundary behavior
  is now a *proven, tested bound* rather than an open-ended risk. Tightening
  further (e.g. a sliding window) is a design/product tradeoff, recorded for the
  operator but not changed here to avoid altering deployed economic behavior.
- **Covering test:** `evm/test/BridgeSupplyFuzz.t.sol`
  (`testFuzz_dailyCapBoundsWindowTotal`, `testFuzz_dailyCapAcrossBoundaryIsAtMost2x`,
  `testFuzz_perTxCapIsHardCeiling`) and `BridgeE2E.t.sol` daily-cap boundary cases.

### L1 — Low — EVM staking `rewardRate` truncation dust  ·  Fixed/mitigated
- **Location:** `evm/src/NaveStaking.sol` (`notifyReward`, `sweepDust`).
- **Description:** `rewardRate = amount / duration` truncates, so a tiny residue
  can remain unspendable in the contract.
- **Root cause:** Integer division in a rate-metered drip.
- **Fix/mitigation:** `sweepDust` (owner) recovers the residue AFTER the window,
  and it provably never touches staker principal or undripped rewards. Fuzzing
  bounds the dust to `< duration` base units and proves principal safety.
- **Covering test:** `evm/test/NaveStakingFuzz.t.sol`
  (`testFuzz_singleStakerSolvencyAndDust`, `testFuzz_sweepDustNeverTouchesPrincipal`,
  `testFuzz_twoStakerProRataConserved`).

### L2 — Low — `WrappedNave` ownership was single-step  ·  Fixed
- **Location:** `evm/src/WrappedNave.sol`.
- **Description:** A fat-fingered `transferOwnership` could brick control.
- **Root cause:** Single-step OZ ownership.
- **Fix:** two-step `transferOwnership`/`acceptOwnership` (and two-step
  `setMinter`/`acceptMinter`) so a bad target cannot take control without
  accepting.
- **Covering test:** `evm/test/WrappedNave.t.sol` (pending-owner accept
  flow, non-pending reverts).

### L3 — Low — `supabase-js` realtime WS needs modern Node  ·  OPERATOR DECISION
- **Location:** `nave-app/signer-service` runtime (Node), `supabase-js ^2.57.x`.
- **Description:** Older Node lacks a global `WebSocket`, which `supabase-js`
  realtime expects; the service uses request/response DB calls (unaffected in
  tests) but realtime features assume a modern runtime.
- **Root cause:** Runtime version drift.
- **Fix (operator):** pin the signer-service runtime to Node ≥ 20.19 (prefer 22)
  in the deploy env (Railway). No code change needed for the paths under test.
- **Covering test:** backend suites pass on the current runtime (request/response
  path); realtime is not exercised.

### L4 — Low — Solana→EVM pre-flight balance check gated on NET, not GROSS (m13)  ·  Fixed
- **Location:** `nave-app/src/hooks/useBridge.tsx` (`bridge()`, `solana_to_evm`
  branch). The page-level `insufficient` predicate in `nave-app/src/pages/Bridge.tsx`
  already compared gross for both directions; only the hook's in-flow guard was
  asymmetric.
- **Description:** The EVM→Solana burn path correctly guarded on the gross
  (`quote.grossRaw > evmWrappedBalance`), but the Solana→EVM lock path guarded
  only on the net (`amountRaw > solanaNaveBalance`) even though the on-chain
  lock instruction pulls net + on-top fee (the gross) from the sender's token
  account. A wallet balance strictly between net and gross passed the hook's
  pre-flight and then failed on-chain with an opaque token-program error —
  a UX defect only (no fund risk; the on-chain transfer simply reverts).
- **Root cause:** The gross-vs-net distinction was applied to the burn path when
  the on-top fee was introduced but the lock path kept the older net-only check.
- **Fix:** The Solana lock guard now compares `quote.grossRaw > solanaNaveBalance`
  and the error toast names the fee, mirroring the EVM path. Root-cause-only
  change; no refactor.
- **Covering test:** `nave-app/tests/frontend/bridgeGuards.test.ts`
  (`Solana→EVM insufficient-balance check compares the GROSS, not the net (m13)`) —
  asserts a balance strictly between net and gross is rejected and a
  gross-covering balance passes, symmetric with the EVM-direction test.

### L5 — Low — EVM drip pre-funding truncated small shares to a zero rate  ·  Superseded by claim-on-demand
- **Location:** `nave-app/signer-service/src/stakingMirror.ts` (EVM delivery
  legs), EVM `NaveStaking.notifyReward`.
- **Description:** `notifyReward` computes
  `rewardRate = (amount + leftover) / rewardsDuration` with integer division;
  with the deployed 365-day duration any delivery under ~31.5 NAVE floored the
  rate to zero — tokens landed in the contract but never dripped (sweep-only
  dust) and `pendingReward` stayed 0, so user claims reverted with `ZeroAmount`
  (masked in wallets as "gas limit too high" after gas estimation fell back).
- **Resolution (architecture change, 2026-07-08):** EVM reward delivery moved to
  **claim-on-demand**. EVM stakers accrue a pro-rata share of the ONE Solana
  reward pool in a server-side ledger (Supabase `evm_reward_accounts`, folded by
  the signer-service worker); the mirror parks EVM fee shares in a relayer-owned
  Solana reserve (`STAKE_CLAIM_RESERVE`) instead of pre-funding drip contracts;
  at claim the relayer verifies an EIP-191 signature from the staking wallet,
  moves the owed NAVE reserve→custody (wNAVE stays fully backed), and mints
  wNAVE straight to the staker via the lockbox with replay partition **902**
  (bridge = 900, mirror top-ups = 901). Legacy batched delivery remains behind
  `STAKE_CLAIM_ENABLED != true` with a rate-floor guard that defers truncating
  shares.
- **Trust note:** payout amounts are a trusted off-chain computation (same trust
  class as the bridge relayer). MAINNET FOLLOW-UP: cap exposure via
  `STAKE_CLAIM_MAX_RAW`, monitor Σ ledger claims vs. reserve inflow.
- **Covering tests:** `signer-service/src/stakeClaims.test.ts` (owed math,
  window clipping, claimable floor, nonce-partition distinctness),
  `stakingMirror.test.ts` (`meetsRateFloor`).

### I1 — Info — Replay PDA binds `source_chain_id` (P6)  ·  Fixed/verified
- **Location:** `nave_bridge/src/constants.rs` + `state.rs` (`ProcessedRelease`),
  `bridgePrograms.ts` (`deriveProcessedRelease`, LE encoding).
- **Description/fix:** the replay PDA is seeded by
  `(seed, config, source_chain_id LE, source_message_id)`, so the same 32-byte
  message id from two source chains derives distinct PDAs — no cross-chain
  collision. The off-chain derivation encodes `source_chain_id` little-endian to
  match `to_le_bytes()`.
- **Covering test:** `solana/tests/bridge-staking-localnet.ts` (PDA
  derivation / replay), `signer-service/src/bridgePrograms.test.ts` (LE encoding).

### I2 — Info — `mint ≤ locked` not globally enforced on-chain  ·  Documented invariant
See "Supply invariants" above. Backing holds by construction (mint follows a
finalized lock) and is bounded per-chain by `supplyCap`; global reconciliation is
an operational monitor (Σ `supplyCap` ≤ custody), surfaced for the operator.

### I3 — Info — `WrappedNave.burnFrom` is dead in lockbox mode  ·  Documented
`burnFrom` is minter-gated and unused in the lockbox deployment (user exits go
through `bridgeBurn`/`burn`). Harmless; documented so it is not mistaken for a
live path.

### I4 — Info — Stale comment claimed public path never re-executes  ·  Fixed
- **Location:** `nave-app/signer-service/src/bridgeRelayer.ts`
  (`HandleBridgeRelayOptions` doc) vs `index.ts` `/bridge-relay` (passes
  `allowRetry: true` when `body.retry === true`).
- **Description:** The options doc asserted "the public HTTP path never sets
  `allowRetry`", but the public `/bridge-relay` route does opt in on an explicit
  user "Retry relay". The behavior is SAFE (re-verifies the live source tx,
  recipient from event, bounded by `retry_count < 5`, tighter IP rate limit,
  double-spend impossible via on-chain replay guards) — only the comment was
  wrong and could mislead a future maintainer.
- **Root cause:** Comment not updated when the retry button path was added.
- **Fix:** corrected the doc comment to describe the two opt-in callers (watcher
  + explicit public retry) and why public retry is safe. No behavior change.
- **Covering test:** `bridgeRelayer.integration.test.ts` (idempotent duplicate
  without retry; bounded re-execution with retry) and
  `bridgeWatcher.integration.test.ts`.

### I5 — Info — Drip clock advances at zero stake  ·  Documented, harmless
With zero staked, the Synthetix drip window can advance without any staker
accruing; when the pool is empty `notifyReward` reverts (EVM) and the Solana
accumulator does not credit non-existent shares, so no reward is lost to a
staker — undripped value remains recoverable (`sweepDust` / next window).
Documented as expected.

---

## Requires operator decision / follow-up (surfaced for the final report)

1. **P1** — split `owner` / `relayer` / `rewarder` / upgrade authority for
   mainnet (Squads cold multisig owner + upgrade authority; dedicated hot relayer;
   distinct rewarder). On-chain authority moves — not executed here.
2. **K1** — move signing keys to KMS/HSM with rotation and least privilege.
3. **I2 / supply** — establish the operational monitor that
   Σ per-chain `supplyCap` ≤ Solana custody, and confirm the 500K total-supply
   policy is enforced by the SPL mint authority (out of bridge/staking code scope).
4. **M3** — decide whether the ≤2x windowed daily-cap boundary is acceptable for
   mainnet economics or should be tightened to a sliding window.
5. **L3** — pin the signer-service deploy runtime to Node ≥ 20.19 (prefer 22).
