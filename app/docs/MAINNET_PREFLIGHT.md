# Mainnet Preflight and Cutover Runbook

This is the canonical mainnet launch checklist and execution flow for Nave.
Use this with:

- `docs/SECRETS.md`
- `docs/RUNBOOKS.md`
- `docs/RECONCILIATION.md`
- `docs/DEVNET_E2E_GATE.md`
- **`DEPLOYMENT_DATA.md`** — operator inputs for the **Base + Robinhood first** cutover

## App launch posture (current)

The shipped app is a **Base observe-only** launch. The contract cutover below still covers Robinhood tooling. The founder create screen does not.

- **Create.** `/create-dao` opens on Quick setup and calls `policyForChain('base', 'conservative')`: 60% stablecoin reserve, 40% deployment cap, 20% per venue, 25% liquidity. The chain selector lists Base only. Advanced setup’s constitution card offers Conservative and Balanced. Aggressive and Custom are not on that card.
- **Closed bridge.** `bridgeCanRedeemNave()` (`src/lib/programConfig.ts`) returns false when the bridge flag is off, `VITE_NAVE_BRIDGE_PROGRAM_ID` is unset, or the id is the closed program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. On EVM mainnet that blocks create: “DAO creation is disabled because locked Solana NAVE cannot be redeemed for wNAVE yet.” Do not broadcast a lock against that program.
- **Observe-only.** An unfunded treasury home says “Next step: fund the treasury. After that, agents are watching.” A funded one says agents are watching, record drift, and do not move capital until a check passes. `NAVE_AUTOPROPOSE_ENABLED` defaults to false, so policy runs do not create proposals. Compound and auto-withdraw stay behind their default-off flags.
- **Capital-verdict gate.** `callSigner` (`supabase/functions/agent-orchestrator/index.ts`) calls `assessSignerPayload` (`supabase/functions/_shared/constitutionVerdict.ts`) before any signer HTTP request. Capital actions (`execute_strategy`, `execute_strategy_direct`, `jupiter_deposit`, `withdraw_from_strategy`, `bundle_rebalance`, `compound`, and any action whose name contains `deposit`) load the on-chain constitution (Solana via `onchain.ts`, EVM via `evmPolicy.ts`) and run `evaluateGuardrails` with `failClosedOnUnknown: true` and `requireCompleteConstitution: true`. A failure or an indeterminate critical check is stored on `constitution_check` and the signer is not called. `persistedConstitutionCheck` refuses a capital log whose check list is empty. With `requireCompleteConstitution`, a cap or floor of `0`, a strategy deploy with missing `navLastRevaluedAt` or `maxNavAgeSeconds <= 0`, and a missing agent gate all fail closed. Rebalance cadence applies when policy intent is `rebalance`, not only when the action name contains `rebalance`. Accounting actions (`update_strategy_position_value`, `revalue_treasury`) are allowed with `accounting_only: true` and amount moved `0`. `clear_halt` requires a readable open agent gate and a fresh constitution read. The dispatcher sets `requireCompleteConstitution: true` on its own `evaluateGuardrails` call as well.

## Base + Robinhood contract cutover

Solana mainnet and Ethereum mainnet are **deferred**. The founder app creates on Base only (see above). The contract cutover still covers these networks:

| Network | Environment |
|---------|-------------|
| Solana | Devnet |
| Ethereum | Sepolia |
| Base | **Mainnet** |
| Robinhood Chain | **Mainnet** (full DAO stack via `--scope full`; bridge/stake also supported) |

1. Fill the Operator inputs `env` block in [`DEPLOYMENT_DATA.md`](../DEPLOYMENT_DATA.md).
2. `npm run cutover:base-rh -- --phase validate`
3. `npm run cutover:base-rh -- --phase all --env <secrets.env> --confirm-mainnet`
4. Merge `deployments/cutover-base-rh.env.generated` into host env (`VITE_EVM_NETWORK=mixed`).
5. Confirm the network switcher labels: Solana (Devnet), Ethereum (Sepolia), Base (Mainnet), Robinhood Chain (Mainnet).

Set `CUTOVER_BASE_SCOPE=full` in `DEPLOYMENT_DATA.md` when Base should also deploy the DAO/adapter stack (not just bridge/stake).

---

## Release Gates (Must Pass Before Mainnet)

### 1) Governance and Security

- [ ] External audit completed, or explicit written risk acceptance approved.
- [ ] Squads multisig configured (recommended at least 3 signers, threshold at least 2).
- [ ] Upgrade-authority handoff plan approved for all six programs.
- [ ] Break-glass pause/freeze procedures rehearsed.
- [ ] Distinct secrets policy enforced (`NAVE_AGENT_SECRET`, `NAVE_SIGNER_SECRET`, `NAVE_INDEXER_SECRET` are unique).
- [ ] `NAVE_MASTER_KEK` generated and rotation procedure rehearsed.

### 2) Toolchain and Build Environment

- [ ] `avm use 0.32.1` confirmed.
- [ ] Solana CLI available and current enough for deploy/authority ops.
- [ ] `cargo build-sbf --tools-version v1.48` works on this machine.
- [ ] `solana-verify` installed for build verification.
- [ ] Docker available for verifiable-build workflows.

### 3) Key Management

- [ ] Mainnet key directory exists with `0700` permissions.
- [ ] Program keypairs generated with `0600` permissions.
- [ ] Deploy payer key is separate from protocol treasury wallet.
- [ ] Deploy payer is funded with enough SOL for deploy + retries + authority updates.
- [ ] No key material is in git-tracked files.

### 4) Test and Validation

- [ ] Contracts unit + localnet tests pass.
- [ ] `beta-path` and checkpoint coverage pass.
- [ ] Frontend typecheck/build pass (`npm run typecheck`).
- [ ] Guardrails evaluation pass (`npm run eval:guardrails`).
- [ ] Decision-quality + prompt-regression scorecards pass (`npm run eval:decisions`, `npm run eval:ft-scorecard`).
- [ ] Eval harness typechecks (`npm run typecheck:eval`).
- [ ] Devnet E2E gate evidence reviewed and accepted.

### 4a) Agent Autonomy (staged behind flags)

The agent decision engine is advisory: deterministic guardrails + on-chain
invariants are always the signing authority. The cutover preflight asserts and
prints the resolved autonomy posture; review it before proceeding.

- [ ] **`NAVE_GUARDRAILS_FAIL_CLOSED` is `true` or unset.** The dispatcher fails
      closed by default; only the literal string `"false"` relaxes it. **It must
      NEVER be `"false"` on mainnet — `mainnet:preflight` REFUSES cutover if it
      is.** Document this requirement in the release ticket.
- [ ] `NAVE_AGENT_MODEL` confirmed (defaults to `claude-sonnet-4-6`). Any
      fine-tuned override has passed the `docs/FINE_TUNING.md` go/no-go scorecard.
- [ ] `NAVE_AUTOPROPOSE_ENABLED` is an explicit decision (default `false`,
      observe-only). Only set `true` after the devnet E2E + eval gates pass.
      Base launch leaves it `false`. Capital moves still pass
      `constitutionVerdict.ts` inside `callSigner` with
      `requireCompleteConstitution: true` before the signer is contacted.
- [ ] `NAVE_AUTOPROPOSE_WITHDRAW_ENABLED` (default `false`) is an additional
      opt-in for withdraw legs and **requires `NAVE_AUTOPROPOSE_ENABLED=true`**
      to take effect — preflight rejects withdraw-enabled without the master gate.
- [ ] `NAVE_COMPOUND_ENABLED` (default `false`) and `NAVE_COMPOUND_MIN_GAIN_BPS`
      (default `100`) reviewed for the intended harvest→redeploy posture.

### 4b) Fee Model and Revenue Wallet (post-redesign)

The fee model is two in-kind fees paid to a single **protocol revenue wallet**:

- **Performance fee — 8.5% of realized yield** (`performance_fee_bps=850`),
  skimmed *inline on the strategy-withdrawal path* (`withdraw_from_strategy` →
  `record_strategy_withdrawal`) before the remainder credits the treasury.
  Principal is never taxed; only the proportional realized gain. There is no
  standalone `collect_performance_fee` instruction anymore.
- **Management fee — 0.65%/yr of idle balance** (`management_fee_bps=65`),
  collected *discretely per registered asset* once per year (UTC-midnight
  anchored) by the management-fee scheduler, paid in-kind to the revenue
  wallet's ATA for each mint.

The cutover preflight asserts and prints this posture; review it before proceeding.

- [ ] **Protocol revenue wallet is set and funded.** `VITE_NAVE_PROTOCOL_FEE_WALLET`
      (and optional server-side mirror `NAVE_PROTOCOL_REVENUE_WALLET`) must be a
      real, non-zero, **funded** mainnet wallet — preflight REFUSES cutover if it
      is missing, the all-zeros default, or unfunded on-chain (it pays rent for
- [ ] **Revenue-wallet ATAs provisioned** for every registered asset mint (USDC,
      wSOL, …). Run before launch and after adding any new mint:
      `npm run provision:revenue-atas:dry` (preview) then `npm run provision:revenue-atas`.
      Missing ATAs cause withdrawal skims to FAIL on-chain.
      its per-mint fee ATAs). It is bound into every DAO at creation and receives
      both fees.
- [ ] Fee bps confirmed: `NAVE_PERFORMANCE_FEE_BPS=850`, `NAVE_MANAGEMENT_FEE_BPS=65`
      (on-chain `FeeConfig` is authoritative; these are surfaced for review and
      validated to be integers in `[0, 10000]`).
- [ ] **Management-fee scheduler enabled.** The worker requires
      `NAVE_OPS_WALLET_SECRET` (the permissionless fee_collector/payer) and runs
      every `MANAGEMENT_FEE_INTERVAL_MS` (default `3600000`, hourly) so each
      asset is collected shortly after its annual UTC-midnight boundary. Each
      tick is a cheap no-op when nothing is due.
- [ ] Revenue-wallet fee ATAs provisioned for every held mint (USDC, wSOL, …)
      so the skim/fee transfers land. See `docs/RUNBOOKS.md`.
- [ ] Agent SOL replenishment tiers reviewed: `NAVE_AGENT_SOL_REQUEST_THRESHOLD=0.05`,
      `NAVE_AGENT_SOL_OPERATE_LEVEL=0.10`, `NAVE_AGENT_SOL_FILL_CEILING=0.25`,
      `NAVE_AGENT_SOL_REFILL_TRIGGER=0.10` (must satisfy
      request ≤ operate ≤ fill-ceiling and refill-trigger ≤ fill-ceiling;
      preflight enforces this ordering).

### 4c) Signer Infrastructure, Cluster, and NAV Freshness (fail-closed)

The signer/edge run on a single cluster selector and a fail-closed rate-limiter.
The cutover preflight asserts and prints this posture; review it before proceeding.

- [ ] **`NAVE_CLUSTER=mainnet`.** Allowed values are `mainnet | mainnet-beta |
      devnet | localnet`, but the mainnet path REQUIRES exactly `mainnet`. This
      single switch drives the on-chain Jupiter program-id assertion and the
      signer rate-limiter fail-closed posture — `mainnet:preflight` REFUSES
      cutover if it is anything else.
- [ ] **`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set.** The signer
      rate-limiter and circuit breaker are backed by Upstash Redis and the signer
      **fails closed** (refuses to sign) when Redis is unreachable. Both are
      REQUIRED on mainnet — preflight REFUSES cutover if either is missing.
- [ ] **`NAVE_SIGNER_SKIP_SIMULATION` is not `true`.** Pre-broadcast simulation
      is the final fail-closed guard. It MUST NOT be `true` on mainnet —
      preflight REFUSES cutover if it is.
- [ ] Signer limiter/breaker tunables reviewed (defaults shown; positive
      integers, validated by preflight): `NAVE_SIGNER_RATE_PER_ACTION=20`,
      `NAVE_SIGNER_RATE_PER_ROLE=20`, `NAVE_SIGNER_RATE_GLOBAL=300`,
      `NAVE_SIGNER_CB_THRESHOLD=5`, `NAVE_SIGNER_CB_WINDOW_MS=60000`,
      `NAVE_SIGNER_CB_COOLDOWN_MS=120000`.
- [ ] **Jupiter program IDs asserted to mainnet values.**
      `JUPITER_LENDING_PROGRAM_ID=jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` and
      `JUPITER_LIQUIDITY_PROGRAM_ID=jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`.
      Preflight REFUSES cutover if they drift; any `VITE_` mirror must match.
- [ ] **NAV freshness deploy guard set.** `NAVE_MAX_NAV_AGE_SECONDS` must be a
      positive integer in `(0, 900]` (recommend `900` to match the on-chain
      `NAV_MAX_STALENESS_SECS=900`). Strategy deploys **hard-block on stale NAV**,
      so `revalue_treasury` must be **fresh (< 15 min)** before any `execute`.
- [ ] **`revalue_treasury` keeper coverage proven.**
      `NAVE_REVALUE_TREASURY_KEEPER_CONFIRMED=passed` is required by the contracts
      cutover. Set it only after the keeper is deployed, monitored, and linked in
      the release ticket.
- [ ] **`NAVE_VAULT_LAST_REVALUED_OFF=130`.** Byte offset of
      `treasury_vault.last_revalued_at` used to read on-chain NAV age (computed
      from the current `TreasuryVault` layout; account LEN 138). Required on
      mainnet so the offset is never silently `0` — preflight REFUSES cutover if
      unset, non-integer, or not equal to `130` (the expected layout offset).
- [ ] **Boot-time fail-closed posture (signer, `NODE_ENV=production`).** The
      signer refuses to start when `SOLANA_RPC_URL` is unset (the
      `localhost:8899` default is rejected on mainnet/devnet or in production)
      and when `NAVE_EVM_MASTER_KEK` is missing/malformed while `NAVE_MASTER_KEK`
      is set — there is no silent EVM→Solana KEK fallback. Preflight also
      REFUSES a cutover where the two KEKs are equal.
- [ ] **`TRUSTED_PROXY_HOPS=1`** (Railway). Rate-limit identity is `req.ip`
      under Express `trust proxy`; the leftmost `X-Forwarded-For` entry is no
      longer used. `0` disables proxy trust.
- [ ] **`/health` shows no `warnings[]` and `status: ok`.** It now reports
      `naveCluster`, `evmNetwork`, `bridge.evmConfirmationsByChain`,
      `bridge.enabledEvmChainIds`, `bridge.lookbackSeconds`,
      `trustedProxyHops`; a `degraded` status flags devnet program IDs on a
      mainnet cluster, the KEK fallback, or the localhost RPC default.
- [ ] **Faucet routes 403 on mainnet regardless of `FAUCET_ENABLED`.**
- [ ] **Agent LLM guardrails (edge secrets).** `LLM_TIMEOUT_MS` (60000),
      `LLM_DAILY_TOKEN_BUDGET` (2000000 per DAO per day; 0 disables),
      `NAVE_EXECUTION_GRACE_SECS` (86400). `agent_action_logs.input_tokens /
      output_tokens` (migration 1784400000) make the budget exact.
- [ ] **`NAVE_BREAK_GLASS_SECRET` UNSET** unless an incident runbook requires
      the `generate-agent-keys` raw-DEK export; unset = mode disabled.
- [ ] **Edge EVM RPC + protocol env present.** Mainnet 1/8453/4663 paths in the
      edge functions REQUIRE `EVM_{ETHEREUM,BASE,ROBINHOOD}_RPC_URL` (public
      fallbacks removed) and `EVM_{ETHEREUM,BASE,ROBINHOOD}_PROTOCOL_ADDRESS`
      (auto-mirrored from the `VITE_` values by `mainnet:platform`).
- [ ] **Signed-challenge auth is timestamped + single-use.** `register-dao`
      (`nave-register-dao|<dao>|<chain_id|solana>|<ms>|<nonce>`),
      `generate-agent-keys` (`nave-agent-keys|<dao>|solana|<ms>|<nonce>`) and
      `watch-dao` (`nave-watch|<dao>|<wallet>|<ms>`) reject unsigned or replayed
      requests; replay keys are canonical `sha256` over decoded signature bytes.
      The deployed frontend MUST be the build that emits these formats.

### 4c-2) Bridge and Devnet Faucet — MUST be off on mainnet unless explicitly reviewed

Both features were added after the initial devnet launch and have not
completed the Phase 6 security review tracked in
`docs/AUDIT_FINDINGS.md` (`phase6-new-features`). Preflight and verify both
REFUSE cutover unless this section is satisfied.

- [ ] **`FAUCET_ENABLED` is not `true`.** The devnet NAVE faucet gives away
      free tokens and must never run against a mainnet wallet/mint. Leave it
      unset or `false`.
- [ ] **Every `BRIDGE_*` var is unset**, OR **`NAVE_BRIDGE_MAINNET_REVIEWED=true`**
      is explicitly set. If any bridge env is set, `BRIDGE_SOLANA_BRIDGE_PROGRAM`
      must be a **new** program id whose account is executable on the configured
      Solana RPC. Preflight **refuses** when that id is missing, when it is the
      closed mainnet id `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`, or when
      `getAccountInfo` shows the account is closed or not executable. The paired
      staking id `AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf` is likewise
      closed and must not be reused. Do not `solana program deploy` those ids.
      **Update (2026-07-06 — hardened bridge):** the bridge
      was re-architected around on-chain programs. Value moves through
      `nave_bridge` (Solana: custody PDA, 2.5%-on-top fee split resolved
      on-chain, per-tx + rolling daily caps, pause, `ProcessedRelease` replay
      PDAs) and the `NaveBridge` EVM lockbox (sole wNAVE minter; same caps /
      pause / replay guards). The destination recipient is embedded IN the
      user's single signed source transaction (`lock`'s `evm_recipient` /
      `bridgeBurn`'s `solanaRecipient`), which supersedes the older off-chain
      `senderSignature` scheme entirely — a third party replaying a public
      sourceTx can only complete the victim's own transfer to the victim's own
      embedded recipient. Verified live on devnet with exact fee-split balance
      assertions and replay rejection (`contracts/solana/scripts/bridge-smoke-devnet.mjs`).
      Before setting `NAVE_BRIDGE_MAINNET_REVIEWED=true`, confirm ALL of:
      - [ ] `nave_bridge` config + `nave_staking` pool `owner` = Squads vault
            (two-step handoff accepted), NOT an EOA.
      - [ ] `WrappedNave.owner` and `NaveBridge` lockbox `owner` = Safe multisig.
      - [ ] `WrappedNave.minter` = the `NaveBridge` lockbox (never an EOA), and
            `supplyCap` is set to a non-zero bound.
      - [ ] Per-tx and rolling daily caps set on BOTH the Solana config and the
            EVM lockbox (not 0/unlimited). Solana now has **two** rolling
            daily caps: inbound `daily_cap` (`release`) and outbound
            `lock_daily_cap` (`lock`). `initialize_config` leaves
            `lock_daily_cap = 0` (unlimited) — the owner MUST call
            `set_lock_daily_cap` before value flows. The contracts cutover
            `verify` phase fails closed if `lock_daily_cap` is still 0.
      - [ ] Solana `nave_bridge` dest-chain allowlist is seeded. An empty
            `allowed_dest_chains` rejects every `lock` (fail-closed default).
            Owner must call `set_dest_chain_allowed(chain_id, true)` for each
            served EVM id (mainnet: 1, 8453, 4663). `bridge-staking-init.mjs`
            accepts repeatable `--dest-chain` and `--lock-daily-cap`. The
            contracts cutover `verify` phase fails closed on an empty list.
      - [ ] Relayer keys (`BRIDGE_SOLANA_RELAYER_AUTHORITY`,
            `BRIDGE_EVM_MINTER_PRIVATE_KEY`) are KMS/HSM-backed per
            `docs/SECRETS.md` "Mainnet bridge key management".
      - [ ] Chain-aware finality: `BRIDGE_EVM_CONFIRMATIONS_1` >= 12,
            `BRIDGE_EVM_CONFIRMATIONS_8453` >= 30, `BRIDGE_EVM_CONFIRMATIONS_4663`
            >= 60 (the relayer's per-chain defaults; cutover refuses lower).
            `BRIDGE_EVM_CONFIRMATIONS` is now only an optional deepen-only floor.
      - [ ] `NAVE_EVM_NETWORK=mainnet` on the signer host — the relayer resolves
            `'base'|'robinhood'|'ethereum'` route names from it and rejects
            them when unset (it no longer sniffs the Solana cluster).
      - [ ] `BRIDGE_LOOKBACK_SECONDS` >= 3600 (missed-event scan window,
            converted to blocks per chain).
      - [ ] Relayer `BridgeLock` decoding is program-attributed: only events
            emitted while `nave_bridge` is top-of-stack AND the program is in
            the tx account keys are accepted (`signer-service` tests cover a
            forged foreign-program event).
      - [ ] `stakeClaims` two-phase: EVM mint receipt first, then Solana
            reserve→custody; rows left in `status='wrapping'` are reconciled
            by the worker tick — check `/bridge-queue` shows none stuck.
      - [ ] Fee env agreement: `BRIDGE_FEE_BPS` == `VITE_NAVE_BRIDGE_FEE_BPS`
            == on-chain `BridgeConfig.fee_bps` (250), split 100/100/50.
      - [ ] Tiny-amount smoke bridge executed in BOTH directions on mainnet
            before public enablement.
      - [ ] **Shared wNAVE (Base/RH):** app + relayer use canonical
            `0xFc04710C…` only — never a parallel second wNAVE. Preferred
            lockboxes are v2 UUPS; keep `BRIDGE_EVM_LOCKBOX_V1_*` until Safe
            `setMinter(v2)` + `acceptMinterRole`. See
            `deployments/cutover-shared-wnave.env.generated`. Do not pause v1
            while supply &gt; 0.
      - [ ] **(Audit P1 — now enforced)** The multisig owner is DISTINCT from the
            relayer/rewarder hot key on every contract. This is the gating
            mainnet finding: all cap/pause/supply setters are `onlyOwner`, so if
            owner == relayer a single key compromise nullifies every guardrail.
            The contracts cutover `verify` phase now FAILS CLOSED unless, on-chain,
            `nave_bridge`/`nave_staking` `owner` is the Squads vault (or pending to
            it) AND `owner != relayer`, and the EVM `NaveBridge`/`NaveStaking`
            `relayer`/`rewarder` != the Safe. Optionally set
            `BRIDGE_SOLANA_RELAYER_PUBKEY` / `BRIDGE_EVM_RELAYER_ADDRESS` so the
            app cutover asserts the separation at config time too.
      - [ ] **(Audit P6 — replay-seed hardening)** `nave_bridge` deployed from the
            build that includes `source_chain_id` in the `ProcessedRelease` PDA
            seed. All four off-chain derivations (signer-service `bridgePrograms.ts`
            `deriveProcessedRelease`, `bridgeRelayer.ts`, the smoke script, and the
            unit test) pass `source_chain_id` little-endian — they MUST match the
            deployed program.
      - [ ] **(Audit — WrappedNave two-step)** `WrappedNave.transferOwnership` is
            now two-step (`pendingOwner` + `acceptOwnership`); the Safe must call
            `acceptOwnership()` to finalize the token handoff (same as the lockbox
            and staking).
      - [ ] **(Audit — supplyCap backing invariant)** The SUM of per-chain wNAVE
            `supplyCap` across all EVM chains MUST be <= the Solana custody NAVE
            backing. Per-chain caps bound one chain's blast radius but do NOT
            enforce global 1:1 backing — govern this operationally at cutover and
            on every cap change.
- [ ] **Independent bridge watcher (audit M-1, `BRIDGE_WATCHER_ENABLED`).** The
      relay is push-driven (`POST /bridge-relay`); a lost POST or a transient
      destination failure previously left funds stranded with no recovery. The
      signer-service watcher retries stale `pending`/`failed` transfers through
      the same on-chain-verified path (bounded by `retry_count`, then parked as
      `stuck`) and optionally scans for missed events. Before mainnet enablement:
      - [ ] Migration `1783000000-bridge_transfers_retry_count.sql` applied
            (adds `retry_count`).
      - [ ] `BRIDGE_WATCHER_ENABLED=true` on the worker; `/bridge-queue` health
            endpoint monitored for `stuck` transfers (operator alert).
      - [ ] The signer image runs Node 22 (Dockerfile `node:22-slim`) — the
            supabase-js/rpc-websockets global-WebSocket requirement (audit L-1).
- [ ] **Staking drip + global-parity mirror (2026-07-06).** Staking no longer
      instant-distributes arriving fees: both `nave_staking` (Solana) and
      `NaveStaking` (EVM) drip rewards over a **rolling 365-day window**
      (Synthetix-style `reward_rate` / `period_finish`), and the bridge's 1%
      staking leg lands in a **neutral relayer-owned collector** account that
      the signer-service mirror splits across chains by live stake weight.
      When `STAKING_MIRROR_ENABLED=true` the cutover enforces
      `BRIDGE_SOLANA_STAKING_POOL_ACCOUNT == BRIDGE_SOLANA_STAKING_COLLECTOR`
      and a lockbox per staking chain. Before enabling on mainnet confirm:
      - [ ] `nave_bridge` `set_config` ran with `staking_pool_owner` = the
            collector's owner (the relayer wallet), and the collector is a
            dedicated token account (NOT the wallet's own ATA — the mirror
            distributes its entire balance).
      - [ ] The pool's drip schedule is live: `reward_duration` = 365d
            (seeded by `initialize_pool`; pre-drip pools need the one-time
            `init_reward_schedule`).
      - [ ] Each `BRIDGE_EVM_STAKING_<chainId>` contract's `rewarder` = the
            relayer EOA and `rewardsDuration()` = 31536000.
      - [ ] `STAKING_MIRROR_SRC_CHAIN_ID` (901) differs from
            `BRIDGE_SOLANA_SRC_CHAIN_ID` (900) — lockbox replay partitions.
- [ ] **EVM claim-on-demand rewards (2026-07-08, `STAKE_CLAIM_ENABLED`).**
      EVM stakers accrue a pro-rata share of the ONE Solana reward pool in the
      Supabase `evm_reward_accounts` ledger; at claim time the relayer verifies
      an EIP-191 signature, settles the ledger FIRST (double-pay guard), moves
      NAVE reserve → bridge custody on Solana, and mints wNAVE straight to the
      staker via the lockbox (replay partition 902). Requires
      `STAKING_MIRROR_ENABLED=true` (the mirror refills the reserve) — enforced
      at cutover. Before enabling on mainnet confirm:
      - [ ] `STAKE_CLAIM_RESERVE` is a DEDICATED mainnet NAVE token account
            owned by the relayer wallet (NOT the wallet's ATA), created before
            cutover and listed in the launch artifact.
      - [ ] `STAKE_CLAIM_SRC_CHAIN_ID` (902) differs from both the bridge (900)
            and mirror (901) partitions — enforced at cutover.
      - [ ] `STAKE_CLAIM_MIN_RAW` is set (>= 1 NAVE recommended): every payout
            costs the relayer a Solana wrap fee + EVM mint gas, so a dust floor
            blocks claim-griefing. Consider `STAKE_CLAIM_MAX_RAW` as a
            blast-radius cap for a compromised signature path.
      - [ ] Supabase migrations through `1783800000-settle_refund_support.sql`
            are applied on the MAINNET project (`fold_evm_reward_accrual` +
            refund-capable `settle_evm_reward_claim`, service-role-only grants).
      - [ ] The worker's stake-claim accrual tick is running (Railway worker
            logs show `stake-claim accrual: folded N account(s)`).
      - [ ] `GET /stake-claim/pool` on the signer returns the reserve balance —
            the app's "Reward pool" tile depends on it.

### 4d) EVM (Ethereum + Base + Robinhood) — OPTIONAL, additive to Solana

The EVM path is **optional**: a Solana-only cutover passes with the entire EVM
block blank. The EVM gates fire ONLY when EVM is enabled — i.e. `VITE_EVM_NETWORK`
is set, or any `VITE_EVM_*_FACTORY_ADDRESS` is present. **Scope is Ethereum (1),
Base (8453) and Robinhood Chain (4663) ONLY** — Sepolia/Base Sepolia/Robinhood
Testnet (testnet) segments and any other EVM chain (BSC `56`, Polygon,
Arbitrum One, …) are **HARD-REJECTED**.

> **Robinhood Chain (4663, Arbitrum Nitro L2; testnet 46630)** supports full DAO
> stacks with `--scope full`. Default `--scope bridge-stake` still deploys only
> WrappedNave + NaveBridge + NaveStaking. Treasuries bridge USDC (CCTP) and ETH
> (Arbitrum Nitro / OP StandardBridge) to sister Ethereum treasuries for yield —
> distinct from the `$NAVE` Solana↔EVM trusted relayer. Verification goes through
> **Blockscout** (no API key). Relayer confirmation depth
> (`BRIDGE_EVM_CONFIRMATIONS_4663`, default and minimum 60) accounts for Nitro
> soft sequencer confirmation ahead of hard L1 finality.

Deploy the EVM contracts FIRST from the contracts repo, then wire the emitted
addresses here:

```bash
# nave-contracts repo (per chain): preflight → build → deploy+verify → adapters → handoff → verify
npm run mainnet:cutover:evm -- --env <env> --chain-id 1    --phase all --scope full --confirm-mainnet   # Ethereum
npm run mainnet:cutover:evm -- --env <env> --chain-id 8453 --phase all --scope full --confirm-mainnet   # Base
npm run mainnet:cutover:evm -- --env <env> --chain-id 4663 --phase all --scope full --confirm-mainnet   # Robinhood DAO stack
npm run mainnet:cutover:evm -- --env <env> --chain-id 4663 --phase all --scope bridge-stake --confirm-mainnet   # Robinhood bridge-only
# Resume individual phases (idempotent):
npm run mainnet:cutover:evm -- --env <env> --chain-id 1 --phase adapters --confirm-mainnet
npm run mainnet:cutover:evm -- --env <env> --chain-id 1 --phase handoff  --confirm-mainnet
# Core addresses land in contracts/evm/deployments/<chainId>.json;
# the per-chain launch artifact lands in contracts/evm/deployments/evm-launch-<chainId>.json
```

Chain 1 is not ready for that command. `deployments/1.json` is an Anvil fixture
(`daoStack: undeployed`). `evm-mainnet-cutover.mjs --chain-id 1` and
`script/deploy-eth-sister-stack.sh` refuse to broadcast while that file is the
chain-1 artifact. Yield-sister cutover waits on a real chain-1 DAO stack.
`evm-launch-8453.json` and `hardened-bridge-unused-parallel-wnave-*.json` are
`do-not-wire` and must not be loaded as live.

Testnet dry-run first (Sepolia 11155111 / Base Sepolia 84532 / Robinhood
Testnet 46630) — same command, no `--confirm-mainnet` is required for testnet
chain ids:

```bash
npm run mainnet:cutover:evm -- --env <env> --chain-id 11155111 --phase all   # Sepolia
npm run mainnet:cutover:evm -- --env <env> --chain-id 84532    --phase all   # Base Sepolia
npm run mainnet:cutover:evm -- --env <env> --chain-id 46630    --phase all   # Robinhood Testnet (bridge stack only)
```

**Contracts EVM deploy inputs** (consumed by `evm-mainnet-cutover.mjs` +
`script/Deploy.s.sol`; per-INVOCATION — set the values for the chain you are
deploying, then change them for the next chain):

- [ ] `EVM_RPC_URL` — single-chain deploy RPC (distinct from the app's
      `EVM_ETHEREUM_RPC_URL`/`EVM_BASE_RPC_URL`). Preflight verifies the RPC's
      chain id equals `--chain-id` and is in scope
      (1/8453/4663/11155111/84532/46630) — BSC `56` / Polygon / Arbitrum One
      are hard-rejected.
- [ ] `EVM_DEPLOY_PRIVATE_KEY` (0x, 64 hex) **or** `EVM_DEPLOY_ACCOUNT` (foundry
      keystore name) — the deploy + handoff signer (initial `PROTOCOL_OWNER`).
      Validated in **preflight**, not mid-deploy. NEVER commit a real key.
- [ ] `PROTOCOL_OWNER`, `PROTOCOL_TREASURY` — 0x addresses; constructor args.
- [ ] `PYTH_ADDRESS` — per-chain Pyth contract (0x).
- [ ] `SAFE_ADDRESS` — Safe multisig receiving authority. Preflight + handoff
      verify it has **on-chain bytecode** (`cast code != 0x`) BEFORE transfer, so
      authority is never sent to an EOA/empty address. After handoff the cutover
      asserts `PythOracle.owner() == Safe` (immediate) and
      `NaveProtocol.pendingOwner() == Safe` (Ownable2Step pending accept).
- [ ] `ETHERSCAN_API_KEY` / `BASESCAN_API_KEY` — block-explorer verify keys for
      the chain being deployed. Robinhood chains verify via **Blockscout** and
      need NO API key.
- [ ] `FORMATION_FEE_WEI=0` (EVM creation is FEE-FREE, mirroring Solana — the
      cutover REFUSES any non-zero value on its mainnet path) and
      `TOKEN_MINT_FEE_WEI=50000000000000000` (0.05 ETH; the separate token-mint
      fee is unchanged) on EVM mainnet. `TOKEN_REVOKE_REWARD_WEI` must be unset
      or `0` because the current EVM contracts do not implement a revoke reward.
- [ ] `TREASURY_SEED_WEI=0` — creation is fee-free, so there is no formation-fee
      carve-out. The contracts EVM cutover REFUSES any non-zero value on mainnet.
- [ ] **EVM NAVE stake** (`--phase stake`, BEFORE the Safe handoff): set
      `NAVE_STAKE_TOKEN` (wrapped NAVE), `REQUIRED_NAVE_STAKE` (the $99-equivalent
      in token base units from the price oracle), and `DAO_STAKE_MODULE`
      (`NaveDaoStake`) so `NaveProtocol.setNaveStakeConfig` + `setDaoStake`
      enforce the same `$99` stake. Unset ⇒ EVM creation stays fee-free with NO
      stake gate until the Safe configures it post-handoff (loud skip on `all`).

**Strategy-adapter deploy inputs** (the `adapters` phase invokes
`script/DeployAdapters.s.sol`, sequenced after `deploy`, before `handoff`). Set
the constructor args for the chain being deployed; **omit a full set to skip
that adapter on that chain**. The protocol address is read from
`deployments/<chainId>.json` automatically. The contracts cutover `adapters`
phase sets `APPROVE_ON_PROTOCOL=true` so each deployed adapter is written to
`NaveProtocol.setAdapterApproved` **before** handoff (a DAO constitution
cannot list an adapter that is not on this allowlist). Constructor → env mapping:

- `AaveV3Adapter(protocol, pool)` → `AAVE_V3_POOL`
- `CompoundV3Adapter(protocol, comet)` → `COMPOUND_V3_COMET`
- `BalancerAdapter(protocol, vault, poolId, bpt, routedAsset, assetIndex, tokenCount)`
  → `BALANCER_VAULT`, `BALANCER_POOL_ID` (bytes32, 0x+64 hex), `BALANCER_BPT`,
  `BALANCER_ROUTED_ASSET`, `BALANCER_ASSET_INDEX` (uint), `BALANCER_TOKEN_COUNT` (uint)
- Curve is intentionally omitted until a vetted deployment/pool exists. Do not
  expose a Curve adapter address in the app or cutover env yet.
  `adapters-8453.json` records `curve.status = dormant` and `curve.offerInUi = false`.
- Base Balancer is **not deployed**. `adapters-8453.json` `balancerAdapter` is
  the zero address, `balancer.status` is `unset`, and `balancer.offerInUi` is
  `false`. Do not deploy Balancer without a pool id and a `minOut` quote. A
  later constitution UI pass should hide both Balancer and Curve from that JSON.
- **Chain-1 DAO addresses are required before yield-sister cutover.**
  Robinhood WETH yield targets an Ethereum sister treasury
  (`VITE_EVM_ROBINHOOD_ARBITRUM_BRIDGE_ADAPTER_ADDRESS`). That path needs
  `VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS` and `VITE_EVM_ETHEREUM_FACTORY_ADDRESS`
  from a real Safe-owned `deployments/1.json`. The checked-in `1.json` is an
  Anvil fixture (`status: anvil-fixture-not-production`, `daoStack: undeployed`).
  Cutover and `script/deploy-eth-sister-stack.sh` refuse to treat it as production.
  Do not overwrite it with placeholder addresses.

> The `script/DeployAdapters.s.sol` file is owned by the contracts agent. If it
> is absent, a full `--phase all` run logs a loud WARNING and continues (adapters
> NOT deployed); `--phase adapters` fails closed.

**Sync the ABIs before the web build.** The frontend must bind the REAL synced
Foundry ABIs, never the committed placeholders. After `forge build` in
`contracts/evm`, run `npm run sync-abi` (strict) in the app repo. The app `build`
auto-runs `sync-abi --allow-missing` via the `prebuild` hook (soft: retains
placeholders + warns when contracts aren't built). When EVM is enabled, the app
`mainnet:preflight`/`mainnet:verify` **REFUSE** cutover unless
`src/abi/abi.meta.json` exists and covers every Nave EVM contract with no
missing artifacts.

When EVM is enabled, the app `mainnet:preflight`/`mainnet:verify` REFUSE cutover
unless ALL of the following hold:

- [ ] **`VITE_EVM_NETWORK=mainnet`.** Testnet on the mainnet path is rejected.
- [ ] **Only Ethereum/Base/Robinhood segments configured.** `VITE_EVM_SEPOLIA_*`
      / `VITE_EVM_BASE_SEPOLIA_*` / `VITE_EVM_ROBINHOOD_TESTNET_*` must be
      unset; any non-`ETHEREUM`/`BASE`/`ROBINHOOD` segment env (e.g. a BSC
      segment) is rejected. An optional explicit `VITE_EVM_CHAIN_ID` must be
      `1`, `8453` or `4663`.
- [ ] **Addresses set + valid.** For each enabled chain,
      `VITE_EVM_<CHAIN>_PROTOCOL_ADDRESS` and `VITE_EVM_<CHAIN>_FACTORY_ADDRESS`
      are checksummed `0x` 20-byte addresses (from the contracts cutover artifact).
- [ ] **Adapter addresses set + artifact-matched.** For Base (and Ethereum when used as a
      yield destination), set `VITE_EVM_<CHAIN>_AAVE_ADAPTER_ADDRESS` /
      `COMPOUND_ADAPTER_ADDRESS` (Balancer only when a validated pool exists). App
      preflight compares them to `contracts/evm/deployments/adapters-<chainId>.json`.
      For Robinhood, set `VITE_EVM_ROBINHOOD_ARBITRUM_BRIDGE_ADAPTER_ADDRESS` (local
      Aave/Compound are N/A — capital bridges out to an Ethereum sister treasury).
      Match `deployments/bridge-adapters-4663.json`.
- [ ] **Protocol adapter allowlist seeded.** After `adapters` (or a Safe
      `setAdapterApproved` if that phase ran without `APPROVE_ON_PROTOCOL`),
      `NaveProtocol.isApprovedAdapter(adapter)` must be true for every address
      the app exposes. Founders cannot add an unapproved adapter to a
      constitution (`AdapterNotProtocolApproved`).
- [ ] **Remote-treasury registry seeded before any cross-chain link.** Owner
      must call `NaveProtocol.setRemoteTreasury(chainId, treasury, true)` for
      each sister treasury (e.g. Robinhood → Ethereum) **before** a founder
      can `setLinkedTreasury`. Unregistered targets revert
      `LinkedTreasuryNotRegistered`.
- [ ] **Protocol revenue wallet set.** `VITE_EVM_PROTOCOL_REVENUE_WALLET` must be
      a non-zero Nave-controlled EVM address; mainnet cutover refuses the app's
      testnet founder fallback.
- [ ] **Verify keys present.** `ETHERSCAN_API_KEY` (Ethereum) and/or
      `BASESCAN_API_KEY` (Base) for the enabled chain(s) — used by the contracts
      EVM cutover to verify on Etherscan/Basescan.
- [ ] **Server/browser RPC present and chain-checked.** `EVM_ETHEREUM_RPC_URL`
      / `EVM_BASE_RPC_URL` / `EVM_ROBINHOOD_RPC_URL` for the EVM indexer +
      signer relayer, and any `VITE_EVM_*_RPC_URL` browser overrides, must
      return `eth_chainId` `1`, `8453` or `4663` respectively. Testnet RPCs
      are refused on mainnet. `VITE_EVM_ROBINHOOD_RPC_URL` MUST be a public
      endpoint (it ships in the browser bundle — never a keyed URL).
- [ ] **EVM key custody KEK present.** `NAVE_EVM_MASTER_KEK` (or `NAVE_MASTER_KEK`
      fallback). The `generate-evm-agent-keys` edge fn and the signer MUST use the
      same selection so wrapped DEKs round-trip.
- [ ] **Safe authority handoff done.** The contracts EVM cutover `handoff` phase
      starts the Ownable2Step transfer of `NaveProtocol` to the Safe; the Safe
      must call `acceptOwnership()` to finalize (verify phase reports pendingOwner).
- [ ] **Synced ABIs in place (no placeholders).** `src/abi/abi.meta.json` exists,
      covers every Nave EVM contract, and reports no `missing` artifacts. Run
      `npm run sync-abi` after `forge build`; the cutover REFUSES otherwise.
- [ ] **Full-scope DAO stack deployed (1 + 8453).** Bridge-stake-only launch
      artifacts leave `deployments/mainnet-launch-artifact.app.json` with
      `evm.enabled: false`. Flip enablement only after contracts cutover
      `--scope full --confirm-mainnet` for Ethereum and Base, Safe
      `acceptOwnership`, adapter artifacts non-zero where required, and ABI sync.
- [ ] **EVM release gates passed.** Set each gate to `passed` only after the
      release ticket links evidence: `EVM_RELEASE_GATE_TOKEN_ACCESS`,
      `EVM_RELEASE_GATE_GOVERNANCE_RATIFICATION`,
      `EVM_RELEASE_GATE_EXECUTION_REQUESTS`,
      `EVM_RELEASE_GATE_ASSET_REGISTRATION`,
      `EVM_RELEASE_GATE_REVALUE_KEEPER`,
      `EVM_RELEASE_GATE_EMERGENCY_FREEZE`, and
      `EVM_RELEASE_GATE_EXPLORER_LINKS`.

### 4e) Unified DAO creation flow — fee split, treasury seed, bootstrap

DAO creation is a single guided flow that seeds the new treasury from the
formation-fee carve-out, ratifies the constitution, starts the agents, and fires
ONE bootstrap action that bypasses the review window so the agents deploy
immediately. The cutover preflight asserts and prints this posture
(`Unified DAO creation flow …`); review it before proceeding.

**Creation is FEE-FREE + recoverable $99 NAVE stake (Solana).** `initialize_dao`
charges no SOL and `global_config.formation_fee_lamports` is `0`/inert on every
network. The DAO creation gate is a recoverable **$99-of-NAVE stake** locked via
`stake_dao_creation` (released to an approved recipient through the moonlighting
lifecycle: `record_moonlight_request` → `set_moonlight_distribution` →
`execute_moonlight_distribution` → `finalize_moonlight`; `restore_dao` re-stakes
to reopen). The user treasury seed is a separate wizard input (wrapped to wSOL,
deposited client-side), not a fee carve-out. `TREASURY_SEED_LAMPORTS = 0`.

- [ ] **`global_config.formation_fee_lamports` is `0` on mainnet.** The app +
      contracts cutovers REFUSE `FORMATION_FEE_LAMPORTS` / `TREASURY_SEED_LAMPORTS`
      (both OPTIONAL) when set to anything but `0`.
- [ ] **Mainnet NAVE stake mint pinned.** The contracts cutover pins the
      canonical mainnet NAVE mint
      `EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory` via `set_nave_mint`
      (`global_config.authority`-gated, run pre-handoff; standalone
      `--phase set-nave-mint`). The devnet replica mint
      `GmBMZuXsXpe7TZK27PTcXUyNGcuw9Ew8v3fxys7wM9Wa` MUST NEVER appear on the
      mainnet path (the cutover fails closed if it does). The launch artifact
      records `naveStake.pinned`.
- [ ] **EVM parity.** Creation is fee-free on EVM too (`formationFee` /
      `treasurySeed` = `0`); the `$99` stake is enforced via
      `NaveProtocol.setNaveStakeConfig` + `setDaoStake` (contracts EVM cutover
      `--phase stake`, pre-handoff).

**Bootstrap activation (immediate first action).** A one-time, founder-gated
`create_execution_request(…, bootstrap=true)` snapshots `review_window = 0` so
the FIRST action deploys immediately (no 24h Oversight wait). The
`dao_registry.bootstrap_used` latch (flipped via a nave_core CPI) blocks reuse;
all later requests use the configured window. Emits `DaoBootstrapUsed` +
`BootstrapExecutionRequestCreated` (indexed by `index-events`; discoverable by
`agent-orchestrator`). EVM `NaveExecution` has the equivalent zero-review-window
first-action mechanism.

- [ ] **Bootstrap first action is SOL→Jito** (no swap dependency). The
      `jupiter_swap` agent capability (wSOL→USDC) is **fail-closed** behind
      `NAVE_SWAP_ENABLED` (default `false`) — the creation/bootstrap flow does NOT
      depend on it. `NAVE_SWAP_MAX_SLIPPAGE_BPS` (default `1000`) caps per-swap
      slippage when enabled.
- [ ] **Review window is editable** post-creation via `set_review_window`
      (bounded `60s..7d`; default `86400s`), surfaced in DAO Settings.

### 5) Mainnet Deployment Readiness

- [ ] `nave_core` compiled with `--features mainnet` (changes `jupiter_lending_program::ID` to mainnet: `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`).
- [ ] IDLs synced after mainnet build: `nave_core.json` → `src/idl`, `signer-service/idl`, `supabase/functions/_shared/idl`.
- [ ] Mainnet protocol addresses and market/reserve/pool addresses validated.
- [ ] Mainnet RPC is dedicated/paid (not public shared RPC).
- [ ] Fresh Supabase project created and ready for migrations.
- [ ] Jupiter API key provisioned and added to Railway vars + Supabase edge secrets (`JUPITER_API_KEY`).
- [ ] Mainnet Jupiter program IDs set in env: `VITE_JUPITER_LENDING_PROGRAM_ID=jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`, `VITE_JUPITER_LIQUIDITY_PROGRAM_ID=jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`; matching `JUPITER_LENDING_PROGRAM_ID` + `JUPITER_LIQUIDITY_PROGRAM_ID` for signer/edge.
- [ ] For each DAO deploying to Jupiter: `configure_position_targets('jupiter', lending_PDA, liquidity_vault)` called once per asset via Assets page. Resolve the lending PDA and vault address from `GET https://api.jup.ag/lend/v1/earn/tokens`.

## Required Inputs (Private Env File)

The cutover command expects a private env file (never commit). Required keys:

- `MAINNET_RPC_URL`
- `DEPLOY_WALLET_PATH`
- `SQUADS_VAULT`
- `VITE_NAVE_PROTOCOL_FEE_WALLET`
- `SUPABASE_PROJECT_REF`
- `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `HELIUS_API_KEY`
- `NAVE_SIGNER_URL`
- `NAVE_AGENT_SECRET`
- `NAVE_SIGNER_SECRET`
- `NAVE_INDEXER_SECRET`
- `NAVE_MASTER_KEK`
- `NAVE_ALLOWED_ORIGINS`
- `ANTHROPIC_API_KEY`
- `NAVE_CLUSTER` (must be `mainnet`)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `JUPITER_LENDING_PROGRAM_ID`
- `JUPITER_LIQUIDITY_PROGRAM_ID`
- `NAVE_MAX_NAV_AGE_SECONDS` (positive integer ≤ `900`)
- `NAVE_VAULT_LAST_REVALUED_OFF` (byte offset of `treasury_vault.last_revalued_at`; `130` for the current layout)
- `NAVE_REVALUE_TREASURY_KEEPER_CONFIRMED=passed`

Program IDs are expected after key generation/deploy:

- `VITE_NAVE_CORE_PROGRAM_ID`
- `VITE_NAVE_GOVERNANCE_PROGRAM_ID`
- `VITE_NAVE_EXECUTION_PROGRAM_ID`
- `VITE_NAVE_JITO_ADAPTER_ID`
- `VITE_NAVE_KAMINO_ADAPTER_ID`
- `VITE_NAVE_MARGINFI_ADAPTER_ID`

Jupiter Lend program IDs (fixed — not deployed by Nave):

- `VITE_JUPITER_LENDING_PROGRAM_ID=jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`
- `VITE_JUPITER_LIQUIDITY_PROGRAM_ID=jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`
- `JUPITER_LENDING_PROGRAM_ID=jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` (signer + edge)
- `JUPITER_LIQUIDITY_PROGRAM_ID=jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC` (signer + edge)
- `JUPITER_API_KEY=<your-api-key>` (Railway secret + Supabase edge secret)

Agent-autonomy flags (optional; safe defaults — see `.env.mainnet.cutover.example`):

- `NAVE_GUARDRAILS_FAIL_CLOSED=true` (or unset) — **must never be `false` on mainnet.**
- `NAVE_AGENT_MODEL=claude-sonnet-4-6` (override only for an approved fine-tuned A/B).
- `NAVE_AUTOPROPOSE_ENABLED=false` (master autonomy gate; observe-only default).
- `NAVE_AUTOPROPOSE_WITHDRAW_ENABLED=false` (requires the master gate to take effect).
- `NAVE_COMPOUND_ENABLED=false`, `NAVE_COMPOUND_MIN_GAIN_BPS=100`.

Fee model + scheduler (defaults — see `.env.mainnet.cutover.example`):

- `NAVE_PROTOCOL_REVENUE_WALLET` — defaults to `VITE_NAVE_PROTOCOL_FEE_WALLET`; **must be funded on mainnet.**
- `NAVE_PERFORMANCE_FEE_BPS=850`, `NAVE_MANAGEMENT_FEE_BPS=65`.
- `NAVE_OPS_WALLET_SECRET` — worker's permissionless management-fee collector/payer (signer/worker host).
- `MANAGEMENT_FEE_INTERVAL_MS=3600000` (hourly management-fee check).
- `NAVE_AGENT_SOL_REQUEST_THRESHOLD=0.05`, `NAVE_AGENT_SOL_OPERATE_LEVEL=0.10`, `NAVE_AGENT_SOL_FILL_CEILING=0.25`, `NAVE_AGENT_SOL_REFILL_TRIGGER=0.10`.

Unified DAO creation flow — FEE-FREE + recoverable $99 NAVE stake (all OPTIONAL; see 4e):

- `FORMATION_FEE_LAMPORTS=0` — creation is fee-free. Unset is fine; when set the
  cutover refuses anything but `0`.
- `TREASURY_SEED_LAMPORTS=0` — no fee carve-out; user seed is supplied separately
  in the creation wizard.
- `MAINNET_NAVE_MINT=EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory` — canonical
  mainnet NAVE stake mint (pinned on-chain by the contracts cutover). When set it
  must match; the devnet replica mint is refused on the mainnet path.
- `FORMATION_FEE_WEI=0` / `TREASURY_SEED_WEI=0` — EVM creation is fee-free too.
- `NAVE_STAKE_TOKEN` / `REQUIRED_NAVE_STAKE` / `DAO_STAKE_MODULE` — EVM wrapped-NAVE
  stake config (contracts EVM cutover `--phase stake`, pre-handoff). Unset ⇒ EVM
  creation stays fee-free with no stake gate until the Safe configures it.
- `NAVE_SWAP_ENABLED=false`, `NAVE_SWAP_MAX_SLIPPAGE_BPS=1000` — agent `jupiter_swap`
  capability (fail-closed; bootstrap first action is SOL→Jito, does not depend on it).

Signer infrastructure (fail-closed on mainnet):

- `NAVE_CLUSTER=mainnet` — **required**, drives the Jupiter program-id assertion + limiter fail-closed.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — **required**; signer fails closed without a reachable Upstash limiter.
- `NAVE_SIGNER_SKIP_SIMULATION` — must **not** be `true` on mainnet (defaults `false`).
- `NAVE_SIGNER_RATE_PER_ACTION=20`, `NAVE_SIGNER_RATE_PER_ROLE=20`, `NAVE_SIGNER_RATE_GLOBAL=300` (optional tunables).
- `NAVE_SIGNER_CB_THRESHOLD=5`, `NAVE_SIGNER_CB_WINDOW_MS=60000`, `NAVE_SIGNER_CB_COOLDOWN_MS=120000` (optional tunables).
- `NAVE_MAX_NAV_AGE_SECONDS=900` — NAV freshness window for deploys (≤ on-chain `NAV_MAX_STALENESS_SECS=900`).
- `NAVE_VAULT_LAST_REVALUED_OFF=130` — byte offset of `treasury_vault.last_revalued_at` (current layout; account LEN 138).
- `NAVE_REVALUE_TREASURY_KEEPER_CONFIRMED=passed` — release acknowledgement that
  the keeper keeping NAV fresh before strategy execution is deployed and monitored.

## One-Command Cutover

```bash
npm run mainnet:cutover -- \
  --env /secure/path/nave-mainnet.env \
  --key-dir /secure/path/nave-mainnet-keys \
  --phase all \
  --confirm-mainnet
```

Phases:

1. `preflight`
2. `keys`
3. `build`
4. `deploy-contracts`
5. `handoff-authority`
6. `deploy-platform`
7. `verify`

You can resume from any phase safely.

## Contracts Checklist

- [ ] Generate or load program keypairs.
- [ ] Build contracts with mainnet feature path.
- [ ] Deploy all six programs to mainnet.
- [ ] **Initialize global config as the UPGRADE AUTHORITY.**
      `initialize_global_config` now requires the deploy/upgrade authority to
      sign **and** pass the `program` + `program_data` accounts (canonical Anchor
      "only upgrade authority" idiom). The cutover runs this init step with the
      deploy wallet (the upgrade authority) **before** the authority handoff, and
      supplies the `nave_core` program account and its BPF-loader `program_data`
      account. Verify the deploy wallet is still the upgrade authority at this point.
- [ ] Write `contracts/solana/deployments/mainnet.json`.
- [ ] Transfer upgrade authority of each program to `SQUADS_VAULT`.
- [ ] Verify authority via `solana program show`.
- [ ] Run `solana-verify` hash checks.

### On-chain behavior changes folded into this cutover (audit revision)

- **`initialize_global_config` is upgrade-authority gated** — must be signed by
  the program's upgrade authority and pass `program` + `program_data` (see above).
- **`deposit_to_vault` requires `mint` + `asset_config`** and only accepts
  **registered stablecoins** (`asset_config.is_stablecoin`). Non-stable assets
  must use the multi-asset `deposit_to_asset` + `revalue_treasury` flow.
- **Strategy deploys hard-block on stale NAV** (`NAV_MAX_STALENESS_SECS=900`).
  `revalue_treasury` must be **fresh (< 15 min)** before `execute`; the app-side
  `NAVE_MAX_NAV_AGE_SECONDS` window must stay within this ceiling.
- **Vault→escrow movement is LIVE and enforced on-chain.**
  `record_strategy_deposit` runs `transfer_vault_to_escrow`, and the adapters
  reject `escrow == vault`. `NAVE_ESCROW_PDA_ENABLED` / `VITE_ESCROW_PDA_ENABLED`
  MUST be `true` (already enforced) so callers derive the escrow PDA.
- **New constants to be aware of:** `PYTH_MAX_CONFIDENCE_BPS=200` (oracle
  confidence ceiling, 2%), `GUARDIAN_ACTION_STALE_SECS=604800` (7-day guardian
  action expiry).
- **Account size growth** (relevant only for pre-existing devnet accounts that
  predate this revision): `DaoRegistry +8`, `GuardianAction +1`,
  `TreasuryVault +8` bytes. Fresh mainnet accounts are created at the new sizes.

## Platform Checklist

### Supabase (Fresh DB)

- [ ] `supabase link --project-ref <new_ref>`
- [ ] `supabase db push`
- [ ] `supabase secrets set ...` for all required secrets
- [ ] `supabase functions deploy`

### Signer and Worker

- [ ] Signer deployed with mainnet RPC and program IDs.
- [ ] Worker running with required secrets and intervals.
- [ ] `/health` reports healthy and secrets configured.

### Helius

- [ ] Register raw mainnet webhook with Authorization header auth.
- [ ] Confirm webhook monitors all six program IDs.
- [ ] Confirm ingestion through `helius-webhook` and `index-events`.

### Frontend

- [ ] All `VITE_*` vars switched to mainnet values.
- [ ] `VITE_USE_MOCKS=false`.
- [ ] Mainnet program IDs and protocol fee wallet set.
- [ ] Build and deploy complete.

## Verify Gate

Run post-cutover checks:

```bash
npm run mainnet:verify -- \
  --env /secure/path/nave-mainnet.env \
  --key-dir /secure/path/nave-mainnet-keys \
  --confirm-mainnet
```

Expected checks:

- Contracts launch artifact present and populated.
- No devnet URLs in live env.
- Program authorities set to multisig.
- `beta:go-no-go` passes.
- Optional `verify:e2e-gate` passes when `DAO_ADDRESS` provided.
- Reconciliation invariants hold.

## Stop Conditions

Immediately stop if any of these fail:

- Mainnet confirmation flag missing.
- RPC does not resolve to mainnet.
- Secrets are missing or duplicate where uniqueness is required.
- Deploy or authority handoff fails.
- Program authority verification fails.
- Supabase migration or function deployment fails.
- Health probes fail.

## Launch Artifact (Redacted)

The cutover process should output a redacted artifact that includes:

- Commit hash
- Deployment timestamp
- Program IDs
- Program authorities
- Supabase project ref
- Webhook ID
- Verification status per phase
- Build hashes / program hash output
- Resolved agent-autonomy flag states (`agentAutonomy`: model, fail-closed,
  auto-propose, withdraw, compound) — flag states only, never secret values.
- Resolved signer-infra posture (`signerInfra`: cluster, `upstashConfigured`
  boolean, `skipSimulation`, rate-limiter + circuit-breaker tunables) — never the
  Upstash URL/token values.
- NAV-freshness guard (`navFreshness`: `maxNavAgeSeconds`,
  `onchainMaxStalenessSecs`, `vaultLastRevaluedOffset`).
- Asserted Jupiter program IDs (`jupiter`: `lendingProgramId`, `liquidityProgramId`).
- Unified creation flow (`creationFlow`: `protocolFeeLamports`,
  `treasurySeedLamports`, `totalCarveoutLamports`, `bootstrapImmediateFirstAction`,
  `reviewWindowSecs`). EVM split (`evm.formationFee`: `treasurySeedWei`,
  `mainnetTreasurySeedBps`, `finalized`) — note `finalized: false` until confirmed.
- EVM launch posture (`evm`: enabled/network, core + adapter addresses,
  `protocolRevenueWallet`, `tokenFees`, explorer/indexer booleans, release-gate
  pass flags) — never secret keys or KEK material.

Never include private keys, secret values, or KEK material.
