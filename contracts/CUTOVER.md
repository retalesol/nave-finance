# Nave Mainnet Cutover Guide (Bridge + Stake)

This is the plain-language operator guide for taking Nave — including the
`nave_bridge` + `nave_staking` bridge/stake service — from testnet to mainnet.
It is driven by an **interactive wizard** that wraps the existing hardened batch
scripts; it does **not** reimplement any cutover logic.

- Wizard: `nave-app/scripts/mainnet-cutover-wizard.mjs`
- Delegated scripts (the wizard only orchestrates these):
  - `nave-app/scripts/mainnet-cutover.mjs` — top orchestrator (Solana + platform)
  - `solana/scripts/mainnet-cutover.mjs` — Solana programs (incl. bridge/staking)
  - `solana/scripts/evm-mainnet-cutover.mjs` — EVM per chain (Ethereum +
    Base + Robinhood Chain; Robinhood is bridge/stake-only — no DAO stack)
- Canonical checklist/runbook: `nave-app/docs/MAINNET_PREFLIGHT.md`
- Audit context (P1 owner≠relayer gate, etc.): `docs/BRIDGE_STAKING_E2E_AUDIT.md`

> **Golden rule:** the wizard **never** asks for or stores a private key. Every
> signature is produced by the chain CLIs / Foundry keystore / hardware wallet
> that the delegated scripts already use. The wizard only passes NON-SECRET args
> (env-file path, key-dir path, chain id) and reads a small non-secret allowlist
> from the env file for its plan output.

---

## 1. Prerequisites

Before running anything in `--live --execute` mode:

- **Env file** — copy `nave-app/.env.mainnet.cutover.example` to a PRIVATE path,
  fill in real values. Keys map 1:1 to `scripts/mainnet-cutover-env.schema.json`.
  Never commit it. The wizard/scripts read it by PATH only.
- **Secure key dir** — a `0700` directory for Solana program keypairs
  (`--key-dir`). Program keypairs are written `0600`. For already-deployed
  programs use `--reuse-program-ids` so program IDs are PRESERVED (in-place
  upgrade — see `.cursor/rules/upgrade-not-deploy.mdc`).
- **Multisigs live** — Squads vault (Solana) and Safe (EVM), each **distinct
  from** the relayer/rewarder hot key (audit **P1**). The Safe must have on-chain
  bytecode before any EVM handoff.
- **Toolchain** — `node`, `npm`, `supabase`, `solana`, `anchor`, `avm`, `cargo`,
  `solana-verify` (Solana); `forge`, `cast` (EVM). Preflight checks versions.
- **Funded deploy wallet** — enough SOL/ETH for deploys + retries + authority ops.
- **Dedicated mainnet RPCs** — Solana mainnet-beta (genesis-hash checked) and,
  if EVM is enabled, Ethereum(1)/Base(8453)/Robinhood(4663) RPCs (chain-id
  checked). Robinhood Chain is an Arbitrum Nitro L2; its testnet is 46630.
- **Bridge review gate** — if any `BRIDGE_*` var is set,
  `NAVE_BRIDGE_MAINNET_REVIEWED=true` is REQUIRED (final review + live
  battle-test complete). See `MAINNET_PREFLIGHT.md` §4c-2.
- **Faucet off** — `FAUCET_ENABLED` must not be `true` on mainnet.

---

## 2. How to run the wizard

```bash
cd nave-app

# 1) DRY RUN (default) — prints the full ordered plan + exact commands +
#    confirmations. Performs NO action, spawns NO subprocess. Run this first.
node scripts/mainnet-cutover-wizard.mjs --dry-run \
  --env /secure/path/nave-mainnet.env --key-dir /secure/path/nave-mainnet-keys

# 2) TESTNET REHEARSAL — Sepolia + Base Sepolia + Robinhood Testnet (46630) via
#    the EVM script's testnet chain ids. Plan-only unless --execute is added.
#    NOTE: the app/contracts
#    Solana cutover scripts are MAINNET-ONLY (hard --confirm-mainnet + mainnet
#    genesis checks, no devnet path) — on a rehearsal those steps auto-skip
#    loudly and the devnet deployment is verified out-of-band instead
#    (solana program show + solana npm run smoke:devnet).
#    Rehearsal-only prompt escapes (REFUSED on --live):
#      SKIP      at any typed confirmation → skip that one step and continue
#                (e.g. an authority handoff that must not target a placeholder)
#      CONTINUE  after a failed step command → record the failure and proceed
node scripts/mainnet-cutover-wizard.mjs --rehearse-testnet --execute \
  --env /secure/path/nave-testnet.env --key-dir /secure/path/nave-testnet-keys

# 3) LIVE MAINNET — requires --confirm-mainnet AND --execute. Prompts for a typed
#    confirmation before every irreversible / fund / authority-moving step.
node scripts/mainnet-cutover-wizard.mjs --live --execute --confirm-mainnet \
  --env /secure/path/nave-mainnet.env --key-dir /secure/path/nave-mainnet-keys
```

Also available via npm: `npm run mainnet:wizard` (dry-run),
`npm run mainnet:wizard:rehearse`, `npm run mainnet:wizard:live` (see both repos'
`package.json`). Extra flags: `--evm`/`--no-evm` (force EVM leg on/off;
auto-detected from the env otherwise), `--reuse-program-ids`, `--state <path>`,
`--reset-state`.

**Per-chain EVM env overrides** — the delegated EVM script takes a single-chain
env (`EVM_RPC_URL`, `NAVE_STAKE_TOKEN`, `PYTH_ADDRESS`, …) while the wizard
sequences several chains from one env file. Prefix a key with the chain segment
(`ETHEREUM__`, `BASE__`, `ROBINHOOD__`, `SEPOLIA__`, `BASE_SEPOLIA__`,
`ROBINHOOD_TESTNET__`) to override it for that chain, e.g.
`SEPOLIA__EVM_RPC_URL=…` / `BASE__NAVE_STAKE_TOKEN=…` /
`ROBINHOOD_TESTNET__EVM_RPC_URL=…`. The wizard writes a derived `0600` per-chain
env file next to the state file and passes it by path. Without prefixed keys the
base env file is used unchanged.

### Resume & idempotency

Progress is written to `nave-app/deployments/cutover-wizard-state.json`. On
restart the wizard **skips**:

1. any step already marked `done` in the state file, and
2. any step whose on-chain artifact already exists — read from the delegated
   scripts' own manifests (`solana/deployments/mainnet.json`,
   `evm/deployments/<chainId>.json`, `adapters-<chainId>.json`,
   `evm-launch-<chainId>.json`). On `--rehearse-testnet` the Solana manifest of
   record is `deployments/devnet.json` instead, so already-deployed devnet
   programs are never re-deployed (upgrade-not-deploy).

A completed on-chain action is therefore never repeated. `--reset-state` starts
a clean checkpoint (it does **not** touch the chain).

**Mode-scoped checkpoints** — a state file records the mode that created it and
is refused by any other mode (a rehearsal checkpoint can never mark `--live`
mainnet steps as done; plan-only dry-run state is discarded silently). Use a
separate `--state` path per mode.

---

## 3. Ordered steps (what happens, and what each prompt asks for)

The wizard derives this order from the actual scripts. EVM (optional) runs first
per chain, then Solana + platform, then the final cross-chain invariant + unpause.
Steps marked **CONFIRM** print an exact plan block and require you to type the
shown string before proceeding (live/rehearse + `--execute` only).

### Group A — EVM per chain (Ethereum 1, then Base 8453, then Robinhood 4663) — only if EVM enabled

> **Robinhood Chain (4663 / testnet 46630) is BRIDGE/STAKE-ONLY**: its `deploy`
> phase deploys ONLY the hardened bridge stack (WrappedNave + NaveBridge lockbox
> + NaveStaking), the adapters/stake steps do not exist for it, and preflight
> skips the DAO fee checks. Verification goes through Blockscout (no API key).
> The optional Robinhood mainnet leg follows the same guarded pattern as Base.

1. **EVM preflight** *(read-only)* — validates RPC chain-id, Safe bytecode,
   fee-free constants (`FORMATION_FEE_WEI`/`TREASURY_SEED_WEI` = 0,
   `TOKEN_MINT_FEE_WEI` = 0.05 ETH), deploy signer configured. No prompt.
2. **EVM build + test** *(local)* — `forge build` + `forge test`. No prompt.
3. **EVM deploy** — **CONFIRM `DEPLOY <SEG> <chainId>`**. Deploys NaveProtocol,
   factory, oracle **and** the hardened bridge/staking/token stack (WrappedNave,
   NaveBridge lockbox, NaveStaking). Bridge/staking **wiring is done here by the
   Solidity scripts**: `WrappedNave.minter` = lockbox, non-zero `supplyCap`,
   per-tx + daily caps, fee split, staking rewarder, `mintPaused = true`.
4. **EVM adapters** — **CONFIRM `DEPLOY <SEG> <chainId> ADAPTERS`**. Deploys the
   subset of Aave/Compound/Balancer adapters whose constructor-arg env vars are set.
5. **EVM stake config** — **CONFIRM `STAKE <SEG> <chainId>`**. `onlyOwner`
   (pre-handoff): `setNaveStakeConfig(NAVE_STAKE_TOKEN, REQUIRED_NAVE_STAKE)` +
   `setDaoStake(DAO_STAKE_MODULE)`. Script reads it back on-chain, fails closed on
   mismatch. Prompt-relevant env: the token, required stake, and module addresses.
6. **EVM authority handoff** — **CONFIRM `HANDOFF <SEG> <chainId> TO SAFE`**.
   Two-step `transferOwnership` of NaveProtocol + bridge stack to the Safe
   (`SAFE_ADDRESS`); Pyth is immediate Ownable. **P1 gate:** fails closed if
   `relayer()`/`rewarder()` equals the Safe. Safe finalizes via `acceptOwnership()`.
7. **EVM verify** *(read-back)* — reads owner/pendingOwner/relayer/rewarder; fails
   closed on the P1 invariant. No prompt; aborts loudly on mismatch.

### Group B — Solana + platform (via the app top orchestrator)

8. **Preflight** *(read-only)* — app env-schema + all safety gates (agent, fee,
   signer-infra, Jupiter, NAV, bridge/faucet, EVM), mainnet RPC genesis-hash,
   revenue-wallet-funded check; then contracts preflight (revalue-keeper confirmed,
   fee-free constants, NAVE mint, deploy wallet present, toolchain). No prompt.
9. **Program keypairs** *(local)* — generate/load into `--key-dir` (idempotent).
   Use `--reuse-program-ids` to preserve existing program IDs. No prompt.
10. **Build** *(local)* — `build.sh --features mainnet` + unit tests. No prompt.
11. **Solana deploy** — **CONFIRM `DEPLOY SOLANA MAINNET CONTRACTS`**. Deploys the
    8 programs (incl. `nave_bridge` + `nave_staking`), runs `initialize_global_config`
    (upgrade-authority gated, pre-handoff) and `set_nave_mint` pinning the canonical
    NAVE mint; writes `mainnet.json` + `mainnet-program-ids.env` + launch artifact.
12. **Bridge/staking init + collector wiring** *(MANUAL)* — **CONFIRM
    `BRIDGE INIT COMPLETE ON MAINNET`**. Not a script phase. Out-of-band you run
    `nave_bridge.initialize_config` (owner = Squads, relayer = KMS hot key DISTINCT
    from owner, fee 250 bps split 100/100/50, non-zero caps, paused),
    `nave_staking.initialize_pool` (owner = Squads, 365-day drip), create the neutral
    relayer-owned NAVE collector, and repoint the staking leg at it via `set_config`
    so `BRIDGE_SOLANA_STAKING_COLLECTOR == BRIDGE_SOLANA_STAKING_POOL_ACCOUNT`.
    (Skipped automatically when the bridge/staking leg is not part of this cutover.)
13. **Confirm/re-pin NAVE mint** — **CONFIRM `PIN NAVE MINT MAINNET`**. Standalone
    `--phase set-nave-mint` (authority-gated, pre-handoff). Idempotent — skips if
    already pinned; fails closed on mismatch.
14. **Solana authority handoff** — **CONFIRM `HANDOFF SOLANA AUTHORITY TO SQUADS`**.
    `set-upgrade-authority` of every program → Squads vault, verified via
    `solana program show`. Run after init + mint-pin (both need the deploy wallet).
15. **Deploy platform** — **CONFIRM `DEPLOY PLATFORM MAINNET`**. Supabase link +
    db push (migrations) + secrets set + functions deploy, then register the mainnet
    Helius webhook over all program IDs. Infra state change.
16. **Verify** *(read-back)* — `solana-verify` program hashes +
    `assertBridgeAndStakingOwnership` (**P1**: owner = Squads/pending AND owner ≠
    relayer), then `beta:go-no-go` (+ `verify:e2e-gate` when `DAO_ADDRESS` set).
    No prompt; aborts loudly on mismatch.

### Group C — Final

17. **Final invariant review** *(MANUAL)* — **CONFIRM `INVARIANTS CONFIRMED`**.
    Human sign-off: owner ≠ relayer/rewarder on every chain (enforced on-chain
    above); Σ per-chain wNAVE `supplyCap` ≤ Solana custody backing;
    `BRIDGE_FEE_BPS == VITE_NAVE_BRIDGE_FEE_BPS == on-chain 250`;
    `BRIDGE_EVM_CONFIRMATIONS ≥ 5`; relayer keys KMS/HSM-backed.
18. **Unpause** *(MANUAL, multisig)* — **CONFIRM `UNPAUSE CONFIRMED BY MULTISIG`**.
    The bridge ships PAUSED. Only after a tiny-amount two-way smoke bridge succeeds
    does the Squads/Safe multisig unpause (`set_paused(false)` / `setPaused(false)` +
    `setMintPaused(false)`) — an out-of-band multisig action the wizard cannot sign.

> **Deviations vs. the plan template** (confirmed against the scripts):
> - The template's *“configure staking/bridge wiring → set fee params (0.5/1/1)
>   → wire+fund staking pool/collector → set mint/burn authorities”* is **not a set
>   of discrete `.mjs` phases**. On EVM these happen inside the Solidity
>   deploy/hardened-bridge scripts at step A3 (constructor/config). On Solana they
>   are the **manual** `initialize_config`/`initialize_pool` + collector wiring at
>   step B12. The fee split is `250` bps = `100` staking / `100` protocol / `50`
>   burn (1% / 1% / 0.5%), set at `initialize_config`.
> - Solana upgrade-authority handoff and EVM ownership handoff are **per-side**
>   (steps B14 and A6), not a single combined step.
> - **Unpause** is a multisig action, surfaced as the final gated step (not scripted).

---

## 4. Rollback / abort guidance per step

The wizard aborts the whole run on any confirmation mismatch or non-zero command
exit — nothing further executes. Because state is checkpointed, you fix the cause
and re-run; completed steps are skipped.

| Step | If it fails / you must back out |
|------|--------------------------------|
| EVM preflight / build (A1–A2) | Safe: nothing on-chain. Fix env/toolchain and re-run. |
| EVM deploy (A3) | Contracts are immutable once deployed; you cannot "undo" a deploy. Re-running skips via `deployments/<chainId>.json`. To replace, deploy fresh contracts and re-point the env — never send authority to a bad address. |
| EVM adapters (A4) | Same as deploy; a bad adapter is simply not wired into the protocol. Redeploy the corrected adapter. |
| EVM stake (A5) | `setNaveStakeConfig`/`setDaoStake` are re-callable by the owner **while still pre-handoff**. Re-run with corrected values before handoff. |
| EVM handoff (A6) | Two-step: authority is only *pending* until the Safe `acceptOwnership()`. If wrong, do **not** accept from the Safe; re-issue `transferOwnership` to the correct Safe. Pyth is immediate — if mis-set, the (correct) Safe must transfer it onward. |
| EVM verify (A7) | Read-only. On P1 mismatch, **stop**: rotate the relayer/rewarder or the owner so they differ, then re-verify. |
| Preflight (B8) | Safe. Fix the failing gate (env/RPC/wallet funding) and re-run. |
| Keys / build (B9–B10) | Safe/local. Regenerate keys or fix the build; nothing on-chain. |
| Solana deploy (B11) | Deploy/upgrade is not reversible in place. With `--reuse-program-ids` it is an in-place upgrade (IDs preserved); a bad ELF is fixed by a corrected upgrade. `initialize_global_config` runs once — if it failed mid-way, inspect `global_config` before re-running. Reclaim dangling BPF buffers (`npm run reclaim:buffers`). |
| Bridge init (B12) | Config setters are owner-gated and re-callable pre-handoff. Fix and re-run `set_config`/`initialize_*`. **Do not hand off** until owner ≠ relayer and caps are non-zero. |
| Pin NAVE mint (B13) | Idempotent + authority-gated pre-handoff. Re-run if the on-chain mint is wrong (before handoff). |
| Solana handoff (B14) | After this, only the Squads vault can upgrade/change authority. If the wrong vault was set, it must be corrected **by that vault**. Verify with `solana program show` before continuing. |
| Deploy platform (B15) | Supabase/Helius are re-runnable (idempotent link/push/secrets/functions). Roll back a bad migration via a new corrective migration; re-set secrets as needed. |
| Verify (B16) | Read-only gate. On failure, **do not proceed to unpause** — fix the root cause and re-verify. |
| Final invariants (C17) | Sign-off gate. If any invariant is violated, halt and remediate on-chain before unpausing. |
| Unpause (C18) | Emergency rollback = **re-pause** from the multisig (`set_paused(true)` / `setPaused(true)`), which the on-chain guardrails allow at any time. |

General stop conditions (from `MAINNET_PREFLIGHT.md`): missing `--confirm-mainnet`,
RPC not resolving to mainnet, missing/duplicate secrets, deploy or handoff failure,
authority verification failure, Supabase/function failure, health-probe failure.

---

## 5. Post-cutover verification checklist

Run/confirm after the wizard completes (most are enforced by the verify phases;
this is the human sign-off):

- [ ] `npm run mainnet:verify -- --env <path> --key-dir <path> --confirm-mainnet`
      passes (program hashes + P1 ownership + `beta:go-no-go`).
- [ ] `solana program show <each program id>` — upgrade authority = **Squads
      vault**; only the last-deployed slot advanced (IDs unchanged).
- [ ] `nave_bridge` BridgeConfig + `nave_staking` StakePool `owner` = Squads
      vault (or pending-accepted), and **owner ≠ relayer** (P1).
- [ ] EVM: Ownable2Step pendingOwner (then Safe `acceptOwnership()`) on
      **protocol, factory, oracle, daoStake** proxies; bridge stack
      (NaveBridge/NaveStaking/WrappedNave) likewise; `relayer()`/`rewarder()` ≠
      Safe (P1). App/relayer env points at **PROXY** addresses only.
- [ ] Bridge dual-live: `hardened-bridge-v1-<chainId>.json` preserved
      (`status: legacy-live`); primary `hardened-bridge-<chainId>.json` is v2
      UUPS. Relayer mints via v2; accepts burns from v1 **or** v2 wNAVE.
      Do not pause v1 while supply &gt; 0.
- [ ] EVM UUPS: `deployments/<chainId>.json` has `proxyPattern:
      uups-singleton+uups-dao-consent`, EIP-1967 impl slots set, and
      `latestImplementations()` non-zero. Upgrade monitor env on Railway:
      `EVM_UPGRADE_PROPOSER_PRIVATE_KEY` (+ protocol proxy).
- [ ] `WrappedNave.minter` = the NaveBridge lockbox (never an EOA); `supplyCap`
      non-zero; Σ per-chain `supplyCap` ≤ Solana custody backing.
- [ ] Per-tx + rolling daily caps set (non-zero) on the Solana config and each
      EVM lockbox.
- [ ] Fee agreement: on-chain `BridgeConfig.fee_bps` = `250`, split 100/100/50 =
      `BRIDGE_FEE_BPS` = `VITE_NAVE_BRIDGE_FEE_BPS`; `BRIDGE_EVM_CONFIRMATIONS ≥ 5`.
- [ ] Staking drip live: `reward_duration` = 31536000 (365d) on Solana and each
      EVM `NaveStaking.rewardsDuration()`; collector = staking pool account;
      `STAKING_MIRROR_SRC_CHAIN_ID` (901) ≠ `BRIDGE_SOLANA_SRC_CHAIN_ID` (900).
- [ ] NAVE mint pinned: launch artifact `naveStake.pinned = true`, mint =
      `EGg56E1YtL5YapzkF7vkRThHR8i5FeRvm2LLuySdYory`; devnet replica mint absent.
- [ ] Platform: Supabase migrations applied, functions deployed, Helius webhook
      registered over all program IDs; signer/worker `/health` healthy;
      `/bridge-queue` monitored for `stuck` transfers; signer image on Node 22.
- [ ] Launch artifacts present: `solana/deployments/mainnet-launch-artifact.json`,
      `nave-app/deployments/mainnet-launch-artifact.app.json`, and per EVM chain
      `evm/deployments/evm-launch-<chainId>.json`.
- [ ] Tiny-amount two-way smoke bridge executed (fee-split balances + replay
      rejection asserted) **before** unpause.
- [ ] Bridge/lockbox unpaused via the multisig; tx signatures recorded in the
      release ticket. Relayer keys confirmed KMS/HSM-backed (`docs/SECRETS.md`).
