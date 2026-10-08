# Nave Bridge + Stake — Mainnet Readiness Assessment

Date: 2026-07-08. Assessed against the current code in `nave-contracts/` and
`nave-app/`, the second-pass audit (`AUDIT_LOG.md`), the service map
(`SERVICE_MAP.md`), and the cutover system (`CUTOVER.md` +
`nave-app/scripts/mainnet-cutover-wizard.mjs`). Every claim below was
re-verified against code on this date, not carried forward.

Test state at assessment time (all green):

| Suite | Result |
|-------|--------|
| EVM `forge test` (incl. new `BridgeInvariant.t.sol`, `BridgeSupplyFuzz.t.sol`, `NaveStakingFuzz.t.sol`) | 84/84 |
| Solana `cargo test --workspace` | green |
| Anchor localnet (`solana/tests/bridge-staking-localnet.ts`) | 7/7 |
| signer-service `npm test` | 61/61 |
| Frontend `npm run test:frontend` (new suite, incl. m13 symmetric-gross guard) | 57/57 |

---

## 1. Go / No-Go by area

### Contracts — **GO, conditional**
- Solana `nave_bridge` / `nave_staking` and EVM `WrappedNave` / `NaveBridge` /
  `NaveStaking` passed a second-pass audit with **no open Critical/High
  code-level findings** (the remaining Critical/High are authority/infra
  posture, not contract logic — §2).
- Supply, fee-split, replay, and cap invariants are enforced on-chain and
  covered by unit + property + fuzz + invariant tests (§3).
- Condition: `evm/script/DeployHardenedBridgeStack.s.sol` is
  **testnet-only by design** — it `require`s chainid ∈ {11155111, 84532} and
  hard-aborts otherwise (lines 31–33). A mainnet deploy path (Safe as owner)
  must be authored/enabled before EVM mainnet deploy (§8).

### Backend (signer-service) — **NO-GO as-is; GO after wiring + infra**
- Relay/mirror/watcher logic is sound and heavily tested (idempotency, replay,
  retry, missed-event recovery, recipient-always-from-event).
- Blocking: mainnet chain ids **1 / 8453 are not wired** —
  `BRIDGE_EVM_CHAINS` (`signer-service/src/bridgeRelayer.ts` lines 76–79),
  `STAKING_EVM_CHAINS` (`stakingMirror.ts` lines 74–77), and
  `resolveEvmChainId` (`bridgeRelayer.ts` lines 209–226) accept only Sepolia /
  Base Sepolia and map the names 'ethereum'/'base' TO the testnets. The file
  header itself says "TESTNET-ONLY trusted-relayer MVP" (§8).
- Blocking: K1 raw-env keys (§4), Upstash provisioning for fail-closed rate
  limiting, dedicated worker service, Node ≥ 20.19 pin (§9).

### Frontend — **GO**
- Bridge/Stake surfaces verified: recipient embedded in the signed source tx
  (never trusted from the client), direction-specific destination validation,
  EIP-55 checksum warning, gross-balance pre-flight now symmetric in BOTH
  directions (m13 / AUDIT_LOG L4, fixed this pass), fee display derived from
  the same bps the quote math uses. Mainnet chains are cleanly unconfigured
  (routes only emit for chains with a WrappedNave address —
  `tests/frontend/bridgeRoutes.test.ts`, `unconfigured/bridgeDisabled.test.ts`).
- New frontend suite (57 tests) covers guards, quotes, routes, chain/checksum,
  program encodings, staking math, and the unconfigured/disabled profile.

---

## 2. Remaining risks by severity (from `AUDIT_LOG.md`)

| # | Severity | Risk | Status / owner |
|---|----------|------|----------------|
| P1 | **Critical** | `owner == relayer == rewarder == upgrade authority` on every chain (devnet: Solana `EJ9qpuQ…ADLn`, EVM `0x6695…E06D`). One key compromise = everything the caps allow, plus cap/pause/upgrade control. | **GATING. Operator must split before unpause.** Mechanism exists (two-step ownership on all contracts; Squads/Safe handoff steps A6/B14 in `CUTOVER.md`); the cutover verify phases fail closed on owner == relayer. |
| K1 | **High** | Relayer/rewarder/minter keys are raw env secrets in signer-service (no KMS/HSM). | **GATING (infra).** Move to KMS/HSM or dedicated signer w/ rotation; on-chain caps bound blast radius meanwhile. |
| M3 | Medium | Windowed daily cap admits up to ~2x nominal across a window boundary. | **Accepted** — bound is proven by fuzz (`BridgeSupplyFuzz.t.sol`); per-tx cap is an absolute per-call ceiling. Set mainnet caps with the 2x boundary in mind. |
| I2 | Medium (operational) | `Σ minted wNAVE ≤ Solana custody` is not asserted on-chain — only per-chain `supplyCap` + caps. | **Operational monitor required** (§3, §7): keep Σ per-chain `supplyCap` ≤ custody and reconcile continuously. |
| L3 | Low | `supabase-js` realtime needs a modern Node runtime. | Pin Node ≥ 20.19 (prefer 22) in the deploy env (§9). |
| L4 | Low | Solana→EVM pre-flight balance gated on net, not gross (m13). | **Fixed this pass** (`useBridge.tsx`; test in `bridgeGuards.test.ts`). |

M1 (watcher recovery), M2 (fee-bps drift guard), L1 (rewardRate dust), L2
(two-step WrappedNave ownership), I1/I3/I4/I5 are fixed or documented — see
`AUDIT_LOG.md` for detail.

---

## 3. Supply & authority invariants — what enforces each

| Invariant | Enforcement | Where |
|-----------|-------------|-------|
| Fee legs sum exactly to the fee (`staking + protocol + burn == fee_bps`, fee ≤ `MAX_FEE_BPS`) | `validate_fee_config` called by `initialize_config` AND `set_config`; split math lets the protocol leg absorb division dust so no value is created/destroyed | `solana/programs/nave_bridge/src/lib.rs` (lines 58, 111, 359), `fees.rs` + its property tests |
| No replayed release (Solana) | `ProcessedRelease` PDA seeded `[b"bridge_processed", config, source_chain_id LE, source_message_id]` — account init fails on second attempt; chain-id in the seed prevents cross-chain message-id collisions | `nave_bridge/src/state.rs` + `constants.rs`; off-chain LE derivation in `signer-service/src/bridgePrograms.ts` |
| No replayed mint (EVM) | `processed[keccak(srcChainId, srcNonce)]` set BEFORE `wnave.mint` (CEI order) | `evm/src/NaveBridge.sol` (lines 109, 123) |
| Per-chain mint ceiling | `WrappedNave.supplyCap` checked in `mint`; only `minter` (the lockbox contract, never an EOA) can mint; `mintPaused` gate | `evm/src/WrappedNave.sol` (lines 100–104) |
| Per-tx / daily flow bound | `perTxCap` (absolute per call) + rolling `dailyCap` on EVM `bridgeIn`; equivalent caps on Solana `release` | `NaveBridge.sol` (lines 106–118); `nave_bridge/src/lib.rs` |
| Custody actually holds the locked gross | `LockNotFullyFunded` — `lock` re-reads the custody balance and reverts if the pulled amount didn't land | `nave_bridge/src/lib.rs` (line 215), `errors.rs` |
| Global `Σ wNAVE minted ≤ NAVE in custody` | **NOT on-chain (I2).** Holds by construction (mint only after a verified, finalized lock) and is bounded per-chain by `supplyCap`; global reconciliation is an OPERATIONAL monitor: keep Σ per-chain `supplyCap` ≤ custody balance | `AUDIT_LOG.md` I2; checklist item in `CUTOVER.md` §5 |
| 500K total NAVE supply | **Enforced by revoked mint authority — VERIFIED on mainnet 2026-07-08** (read-only RPC): mint `EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory` has `mintAuthority: null` and `freezeAuthority: null`, supply fixed at 499,971.243635 NAVE (6 decimals). No one can mint NAVE ever again; the bridge/staking programs never mint NAVE, only move/lock/burn it. | mainnet `getAccountInfo` (jsonParsed); referenced in `solana/STAKE_QUOTE_ORACLE_CONTRACT.md` |
| Admin changes gated + un-brickable | Owner-only setters; two-step `transfer_ownership`/`accept_ownership` (Solana) and `transferOwnership`/`acceptOwnership` + two-step `setMinter`/`acceptMinter` (EVM) on every contract | `nave_bridge`/`nave_staking` `lib.rs`; `WrappedNave.sol`, `NaveBridge.sol`, `NaveStaking.sol` |
| Config init race | `initialize_config` / `initialize_pool` are upgrade-authority-gated (localnet-tested) | `nave_bridge`/`nave_staking`; `tests/bridge-staking-localnet.ts` |

---

## 4. Key-management posture

- **Today (K1, High):** every hot key — Solana relayer
  (`BRIDGE_SOLANA_RELAYER_AUTHORITY`), EVM minter/relayer
  (`BRIDGE_EVM_MINTER_PRIVATE_KEY`), rewarder — is a **raw env secret** read by
  `signer-service/src/bridgeRelayer.ts` `readBridgeConfig()` /
  `stakingMirror.ts`. Host/process compromise or a log leak exposes them.
  Promised posture (KMS/HSM, rotation, least privilege) is **not implemented**.
- **Required for mainnet:** KMS/HSM-backed (or dedicated signer-host) relayer
  and rewarder keys; the final-invariant step C17 in `CUTOVER.md` explicitly
  requires "relayer keys KMS/HSM-backed" before sign-off.
- **Upgrade/ownership handoff plan (mechanism ready, execution is operator):**
  - Solana: all program upgrade authorities → **Squads vault**
    (`CUTOVER.md` step B14, verified via `solana program show`); `BridgeConfig`
    / `StakePool` `owner` → Squads via two-step ownership (init at B12 sets
    owner = Squads directly).
  - EVM: NaveProtocol + bridge stack ownership → **Safe** via two-step
    `transferOwnership` (step A6); handoff **fails closed if
    `relayer()`/`rewarder()` == Safe** (P1 gate); Safe finalizes with
    `acceptOwnership()`.
  - Two-step ownership exists on every contract in scope (audit L2 closed the
    last single-step gap in `WrappedNave`).

---

## 5. Pause / emergency controls

| Chain | Control | Who can trigger |
|-------|---------|-----------------|
| Solana `nave_bridge` | `set_paused(true)` — halts `lock` + `release` | `BridgeConfig.owner` (mainnet: Squads) — `lib.rs` line 144 |
| Solana `nave_staking` | `set_paused(true)` — halts stake/claim; **`unstake` stays available while paused** (principal never trapped) | `StakePool.owner` (Squads) — `lib.rs` line 194 |
| EVM `NaveBridge` | `setPaused(true)` — halts `bridgeIn` (minting) | `owner` (Safe) — `NaveBridge.sol` line 139 |
| EVM `WrappedNave` | `setMintPaused(true)` — independent mint freeze even if the lockbox is compromised; `supplyCap` lowering | `owner` (Safe) — `WrappedNave.sol` line 165 |
| EVM `NaveStaking` | `setPaused(true)` — unstake remains available | `owner` (Safe) — `NaveStaking.sol` line 247 |
| Backend | `BRIDGE_RELAYER_ENABLED=false` → `/bridge-relay` returns 503; worker loops no-op | Anyone with deploy-env access (Railway) |

Launch posture per `CUTOVER.md`: everything ships **PAUSED**; unpause is the
final multisig-only step (C18) after a two-way smoke bridge. Emergency rollback
= re-pause from the multisig, allowed at any time. Note the P1 corollary: until
the authority split happens, "who can trigger" is one key for everything.

---

## 6. Monitoring / alerting gaps (all currently unpaged)

- **`GET /bridge-queue`** (`signer-service/src/index.ts`) exposes
  pending/failed/stuck counts — but nothing polls it or pages anyone. A
  `stuck` transfer (retries exhausted) is user money in limbo until a human
  looks.
- **Fee-bps drift guard is non-fatal, log-only by design**
  (`checkBridgeFeeBpsDrift`, `bridgeRelayer.ts` lines 254–298): on drift it
  logs and continues; env-vs-app agreement is only checked in CI
  (`feeBpsDrift.test.ts`). Without log alerting, a drift can run silently.
- **No pager/alerting integration anywhere** — no PagerDuty/Slack/webhook on
  relay failures, watcher parking rows as `stuck`, mirror failures, or rate
  limiter entering fail-closed.
- **Indexer health**: `evm-indexer` / Helius webhook liveness isn't monitored;
  a dead indexer silently stales the activity/history surfaces.
- **I2 supply reconciliation monitor doesn't exist yet** (Σ `supplyCap` ≤
  custody; ideally Σ actual `totalSupply` ≤ custody) — must be built/scheduled.
- `/health` exists for signer + worker but needs an external uptime check.

---

## 7. Wizard step B12 — manual checkpoint (flagged)

`CUTOVER.md` step B12 ("Bridge/staking init + collector wiring") is a **gated
MANUAL step, not a script phase**: the operator runs
`nave_bridge.initialize_config` (owner = Squads, relayer = distinct KMS hot
key, fee 250 = 100/100/50, non-zero caps, paused) and
`nave_staking.initialize_pool` out-of-band, creates the neutral relayer-owned
NAVE collector, and repoints the staking leg via `set_config`. The wizard only
gates on typed confirmation `BRIDGE INIT COMPLETE ON MAINNET` — it cannot
verify the init happened correctly. Mitigation: the B16 verify phase
(`assertBridgeAndStakingOwnership`) and the `CUTOVER.md` §5 checklist re-check
owner/relayer/caps/fee after the fact, but the collector wiring
(`BRIDGE_SOLANA_STAKING_COLLECTOR == BRIDGE_SOLANA_STAKING_POOL_ACCOUNT`) is
human-verified only. Treat B12 as the highest-care manual moment of the cutover.

---

## 8. Bridge is TESTNET-ONLY in code — must-resolve (verified 2026-07-08)

- `signer-service/src/bridgeRelayer.ts`: `BRIDGE_EVM_CHAINS` contains only
  `11155111` (Sepolia) and `84532` (Base Sepolia) (lines 76–79);
  `resolveEvmChainId` rejects everything else and **maps 'ethereum'/'base' to
  the testnets** (lines 209–226); config reads only
  `BRIDGE_EVM_WRAPPED_NAVE_11155111/84532` + `BRIDGE_EVM_LOCKBOX_11155111/84532`
  env names. The module header states "TESTNET-ONLY trusted-relayer MVP".
  (Header also carries a stale "2% fee" comment; actual default is 250 bps.)
- `signer-service/src/stakingMirror.ts`: `STAKING_EVM_CHAINS` likewise only
  11155111/84532 (lines 74–77).
- `evm/script/DeployHardenedBridgeStack.s.sol`: `require(chainid ∈
  {11155111, 84532})` — **hard-aborts on mainnet** (lines 31–33), intentionally,
  because it makes the broadcaster the owner (mainnet needs a Safe-owner
  variant).
- Frontend: chain-id set includes 1/8453 (`src/lib/chain/*`), but no mainnet
  WrappedNave/lockbox is configured, so no mainnet route can be emitted (safe
  fail-closed; tested).

**Required work before mainnet:** add 1 (Ethereum) / 8453 (Base) to
`BRIDGE_EVM_CHAINS` + `STAKING_EVM_CHAINS` + `resolveEvmChainId` (and fix the
name mapping so 'ethereum'/'base' resolve by environment, not hardcoded to
testnets), add the corresponding `BRIDGE_EVM_*_1` / `_8453` env plumbing, and
author a mainnet-safe EVM deploy path (Safe owner) to replace the testnet-only
hardened-stack script. Then re-run the full backend suite. The cutover env gate
`NAVE_BRIDGE_MAINNET_REVIEWED=true` (`CUTOVER.md` §1) exists precisely to force
this review.

---

## 9. Infra prerequisites

- **Upstash provisioning is REQUIRED for mainnet**: `signer-service/src/rateLimit.ts`
  `limiterMode()` — with no `UPSTASH_REDIS_REST_URL`/`TOKEN` on a mainnet
  cluster the limiter goes **fail-closed and rejects every request** (correct
  but a total outage); non-mainnet falls back to per-process memory (not
  distributed). Provision Upstash before cutover (covered by
  `rateLimit.test.ts`).
- **Dedicated worker service**: `signer-service/src/worker.ts` (watcher, mirror,
  leases) must run as its **own Railway service** alongside the HTTP signer —
  the money-recovery loops must not depend on the web dyno's lifecycle. DB
  leases (`worker_locks`) already make multi-replica safe.
- **Node ≥ 20.19 (prefer 22)** pinned in the deploy env (audit L3;
  `supabase-js` realtime needs global `WebSocket`). `signer-service/package.json`
  currently has **no `engines` field** — pin it in Railway config and/or add
  `engines`.

---

## 10. MUST-FIX-BEFORE-CUTOVER vs ACCEPTABLE-TO-DEFER

### Must fix before mainnet cutover (in order)

1. **P1 authority split** — Squads owner + upgrade authority (Solana), Safe
   owner (EVM), distinct KMS-backed relayer, distinct rewarder. Verified by the
   cutover P1 gates. *(Gating Critical.)*
2. **K1 key management** — relayer/rewarder/minter keys out of raw env, into
   KMS/HSM or an equivalent hardened signer, with rotation.
3. **Mainnet chain wiring (§8)** — 1/8453 in `BRIDGE_EVM_CHAINS` /
   `STAKING_EVM_CHAINS` / `resolveEvmChainId` + env plumbing + a mainnet-safe
   EVM deploy script; backend suite re-run green.
4. **Upstash provisioning (§9)** — else the mainnet limiter fail-closes the
   public relay entirely.
5. **Dedicated worker Railway service + Node ≥ 20.19 pin (§9).**
6. **I2 operational supply monitor (§6)** — automated Σ `supplyCap` (and
   ideally Σ `totalSupply`) ≤ custody reconciliation with alerting.
7. **Minimum alerting (§6)** — page on: `stuck` bridge rows (`/bridge-queue`),
   relay/watcher/mirror failures, fee-bps drift, limiter fail-closed,
   `/health` down.
8. **B12 manual init executed with four-eyes review (§7)** and the `CUTOVER.md`
   §5 checklist completed, including the tiny-amount two-way smoke bridge,
   before the multisig unpause (C18).

### Acceptable to defer (documented, bounded)

- **M3** ~2x daily-cap window boundary — proven bound; size mainnet caps
  accordingly; sliding window is a later design change.
- **L1** staking `rewardRate` dust — recoverable via `sweepDust`, principal
  provably safe.
- **I3** dead `WrappedNave.burnFrom` in lockbox mode; **I5** drip clock at zero
  stake — documented, harmless.
- Stale "2% fee" header comment in `bridgeRelayer.ts` (cosmetic; on-chain
  config is the source of truth, guarded by the drift check).
- Playwright end-to-end browser flow (unit/integration coverage is strong;
  folds into the testnet rehearsal).
- Trusted single-relayer model itself (vs light-client/threshold attestation) —
  an accepted architectural posture for launch, bounded by caps + pause +
  monitoring; revisit post-launch.

---

## 11. Final recommendation

**NO-GO today; CONDITIONAL GO once the eight must-fix items in §10 are done.**

The on-chain contract layer is in good shape: no open code-level Critical/High
findings, invariants enforced and fuzz/invariant-tested, everything ships
paused with multisig-gated unpause. What blocks mainnet is not contract logic —
it is (a) the P1 single-key authority posture, (b) raw-env key custody, and
(c) the fact that the backend and the EVM deploy script are literally
testnet-only in code today. Items (a) and (b) are operator/infra actions the
cutover flow already gates on; item (c) is a small, well-scoped code change
that must land and re-test before any mainnet cutover is even mechanically
possible.

Recommended sequence: land §8 wiring → K1 KMS + Upstash + worker/Node infra →
testnet-live rehearsal of the full wizard (already planned as the next phase) →
execute the cutover with P1 split enforced by its gates → smoke bridge →
multisig unpause.
