# Nave Finance

Nave is an autonomous treasury operating system. A DAO deposits assets, ratifies a constitution, and four AI agents propose and review treasury actions. On-chain programs are the authority: they enforce allocation caps, liquidity floors, review windows, and the constitution. The model can be wrong without the treasury being harmed.

This repository is the monorepo operators build from. The application lives in `app/`. Contracts live in `contracts/`, split by chain, with one shared Solidity project for every EVM network.

**Status.** Contracts have not completed a formal third-party audit. Treat every chain as unaudited. DAO creation in the app is wired for **Base** and **Robinhood Chain**. Solana DAO program ids checked into this repo are the devnet stack. The previous Solana mainnet `nave_bridge` / `nave_staking` deployment that locked NAVE is closed (`Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`); wNAVE redeem stays unavailable until a replacement bridge is paused-in and configured. Agent autonomy defaults to **observe-only**: policy runs record drift and do not create proposals until `NAVE_AUTOPROPOSE_ENABLED=true`.

## In this README

- [Documentation map](#documentation-map) — every guide in this repo, and what it is for
- [Product](#product) — constitution, agents, chains, fees
- [How the system runs](#how-the-system-runs)
- [Repository map](#repository-map)
- [Agentic system](#agentic-system)
- [Local development](#local-development)
- [Deploy](#deploy)
- [Cutover and day-2 operation](#cutover-and-day-2-operation)

## Documentation map

Open the doc for the job you have. Paths are from the repository root.

### Start here

| If you are… | Read |
| --- | --- |
| New to the product | [`app/docs/portal/introduction.md`](app/docs/portal/introduction.md), then [`app/docs/portal/getting-started.md`](app/docs/portal/getting-started.md) |
| Running a treasury | [`app/docs/portal/treasury-operations.md`](app/docs/portal/treasury-operations.md) and [`app/docs/portal/using-nave.md`](app/docs/portal/using-nave.md) |
| Deploying or on call | [`app/docs/MAINNET_PREFLIGHT.md`](app/docs/MAINNET_PREFLIGHT.md), [`app/docs/SECRETS.md`](app/docs/SECRETS.md), [`app/docs/RUNBOOKS.md`](app/docs/RUNBOOKS.md) |
| Changing the app | [`app/README.md`](app/README.md) and [`app/docs/portal/contributing.md`](app/docs/portal/contributing.md) |
| Changing contracts | [`contracts/README.md`](contracts/README.md) and [`contracts/evm/README.md`](contracts/evm/README.md) |
| Evaluating risk | [`app/docs/portal/product-maturity.md`](app/docs/portal/product-maturity.md) and [`app/docs/portal/risk-and-controls.md`](app/docs/portal/risk-and-controls.md) |
| Reviewing a treasury move | [`app/docs/GENLAYER.md`](app/docs/GENLAYER.md) |

### Product portal — `app/docs/portal/`

Written for readers who are not in the code. The in-app docs site serves these pages.

| Doc | What it is for |
| --- | --- |
| [`introduction.md`](app/docs/portal/introduction.md) | What Nave is, who the portal is for, and the control loop |
| [`getting-started.md`](app/docs/portal/getting-started.md) | First treasury: wallet through a Base treasury agents can watch |
| [`using-nave.md`](app/docs/portal/using-nave.md) | Screen-by-screen tour of the app |
| [`treasury-operations.md`](app/docs/portal/treasury-operations.md) | Operating lifecycle for a DAO operator or fund manager |
| [`constitution-and-policy.md`](app/docs/portal/constitution-and-policy.md) | On-chain rulebook and the policy engine that checks it |
| [`tokenomics.md`](app/docs/portal/tokenomics.md) | `$NAVE`, wNAVE, and how the bridge moves value |
| [`architecture.md`](app/docs/portal/architecture.md) | Four layers: app, Supabase, signer, chain |
| [`integration.md`](app/docs/portal/integration.md) | How a developer connects to on-chain and off-chain surfaces |
| [`faq.md`](app/docs/portal/faq.md) | Common questions and a glossary |
| [`security-and-trust.md`](app/docs/portal/security-and-trust.md) | Security posture for someone who will not read every runbook |
| [`risk-and-controls.md`](app/docs/portal/risk-and-controls.md) | Why the model is advisory and what actually gates a signature |
| [`product-maturity.md`](app/docs/portal/product-maturity.md) | Honest readiness assessment |
| [`investment-overview.md`](app/docs/portal/investment-overview.md) | Thesis and differentiation for investors |
| [`contributing.md`](app/docs/portal/contributing.md) | Local app workflow and change conventions |

### Launch, agents, and operations — `app/docs/`

| Doc | What it is for |
| --- | --- |
| [`MAINNET_PREFLIGHT.md`](app/docs/MAINNET_PREFLIGHT.md) | Canonical launch checklist and Base + Robinhood cutover |
| [`DEPLOYMENT_DATA.md`](app/DEPLOYMENT_DATA.md) | Operator inputs the Base + Robinhood cutover reads. Fill locally; do not commit secrets |
| [`SECRETS.md`](app/docs/SECRETS.md) | Every secret, where it lives, and how to rotate it |
| [`FEATURE_FLAGS.md`](app/docs/FEATURE_FLAGS.md) | Env flags, including autonomy gates that default off |
| [`RUNBOOKS.md`](app/docs/RUNBOOKS.md) | Pause, upgrade authority, revenue wallet, incident steps |
| [`RECONCILIATION.md`](app/docs/RECONCILIATION.md) | Treasury invariants that must hold, and the alerts around them |
| [`RLS.md`](app/docs/RLS.md) | Postgres row-level security. There is no Supabase Auth login |
| [`BETA_LAUNCH.md`](app/docs/BETA_LAUNCH.md) | Devnet public-beta go/no-go checklist |
| [`DEVNET_E2E_GATE.md`](app/docs/DEVNET_E2E_GATE.md) | Evidence required before calling the devnet path done |
| [`DEVNET_MULTICHAIN_BETA_E2E.md`](app/docs/DEVNET_MULTICHAIN_BETA_E2E.md) | Solana devnet plus EVM testnets, exercised together |
| [`AGENTIC_E2E_MULTICHAIN_RUNBOOK.md`](app/docs/AGENTIC_E2E_MULTICHAIN_RUNBOOK.md) | Agent pipeline across Solana devnet, Sepolia, and Base Sepolia |
| [`FINE_TUNING.md`](app/docs/FINE_TUNING.md) | Agent context contract and the scorecard a model override must pass |
| [`GENLAYER.md`](app/docs/GENLAYER.md) | Independent review above Solana, Ethereum, Base, and Robinhood. A finished check can stop a signature. It cannot approve a transfer |
| [`ALIGNMENT_VERIFICATION.md`](app/docs/ALIGNMENT_VERIFICATION.md) | Frontend, backend, signer, and on-chain instruction alignment |
| [`TREASURY_CAPITAL_BRIDGES.md`](app/docs/TREASURY_CAPITAL_BRIDGES.md) | Agent hops of USDC, ETH, and WETH between Base, Ethereum, and Robinhood |
| [`SAFE_DAO_STAKE_WIRING.md`](app/docs/SAFE_DAO_STAKE_WIRING.md) | Safe steps to set the NAVE DAO-creation stake on Base and Robinhood |
| [`SAFE_WNAVE_MINTER_ROTATION.md`](app/docs/SAFE_WNAVE_MINTER_ROTATION.md) | Safe steps to rotate the wNAVE minter and accept UUPS ownership |
| [`AUDIT_FINDINGS.md`](app/docs/AUDIT_FINDINGS.md) | Consolidated product-audit ledger and what was re-verified |
| [`PLATFORM_STATE_AND_REDEPLOY_PLAN_2026-09-05.md`](app/docs/PLATFORM_STATE_AND_REDEPLOY_PLAN_2026-09-05.md) | Snapshot of app, Supabase, signer, and indexer, plus the redeploy plan |
| [`FINAL_SYSTEM_STATUS_2026-05-31.md`](app/docs/FINAL_SYSTEM_STATUS_2026-05-31.md) | Earlier cross-repo status snapshot |
| [`CHAIN_REPROBE_2026-10-01.md`](app/docs/CHAIN_REPROBE_2026-10-01.md) | Read-only chain reprobe. No transactions were sent |
| [`JOURNEY_SMOKE_2026-10-01.md`](app/docs/JOURNEY_SMOKE_2026-10-01.md) | Testnet journey smoke. No mainnet transactions |

### Services — READMEs next to the code

| Doc | What it is for |
| --- | --- |
| [`app/README.md`](app/README.md) | App layout, edge functions, Helius webhook, local `npm run dev` |
| [`app/signer-service/README.md`](app/signer-service/README.md) | `/sign` body, health check, and how the orchestrator reaches the signer |
| [`app/scripts/rotate-kek.md`](app/scripts/rotate-kek.md) | Re-wrap every agent data key when `NAVE_MASTER_KEK` rotates |
| [`app/evm-indexer/README.md`](app/evm-indexer/README.md) | EVM `getLogs` poller: cursors, confirmations, and `index-events` |
| [`app/supabase/functions/helius-webhook/SETUP.md`](app/supabase/functions/helius-webhook/SETUP.md) | Helius raw-log webhook for Solana program events |

### Contracts — `contracts/`

| Doc | What it is for |
| --- | --- |
| [`contracts/README.md`](contracts/README.md) | Chain folders and how to run Solana and Forge tests |
| [`contracts/evm/README.md`](contracts/evm/README.md) | Foundry project: build, test, deploy, and UUPS upgrade |
| [`contracts/evm/FEATURE_PARITY_MATRIX.md`](contracts/evm/FEATURE_PARITY_MATRIX.md) | Every Solana instruction mapped to an EVM function and test |
| [`contracts/SERVICE_MAP.md`](contracts/SERVICE_MAP.md) | Bridge and stake trust boundaries, entry points, and lifecycles |
| [`contracts/CUTOVER.md`](contracts/CUTOVER.md) | Wizard guide for bridge and stake mainnet cutover |
| [`contracts/MAINNET_READINESS.md`](contracts/MAINNET_READINESS.md) | Bridge and stake readiness assessment (2026-07-08) |
| [`contracts/AUDIT_LOG.md`](contracts/AUDIT_LOG.md) | Bridge and stake audit log |
| [`contracts/docs/MAINNET_BRIDGE_STAKING_RUNBOOK.md`](contracts/docs/MAINNET_BRIDGE_STAKING_RUNBOOK.md) | Authority handoff for bridge and staking |
| [`contracts/docs/BRIDGE_STAKING_E2E_AUDIT.md`](contracts/docs/BRIDGE_STAKING_E2E_AUDIT.md) | End-to-end bridge and staking analysis |
| [`contracts/solana/SECURITY.md`](contracts/solana/SECURITY.md) | Solana threat model: governance, agents, and strategy execution |
| [`contracts/solana/AUDIT_CHANGES.md`](contracts/solana/AUDIT_CHANGES.md) | On-chain fixes bundled for audit |
| [`contracts/solana/tests/TESTING.md`](contracts/solana/tests/TESTING.md) | How to run the Anchor test suites |
| [`contracts/solana/deployments/README.md`](contracts/solana/deployments/README.md) | Sanitized Solana deployment records. RPC URLs are placeholders |
| [`contracts/solana/BRIDGE_RELAYER_MVP.md`](contracts/solana/BRIDGE_RELAYER_MVP.md) | Why the bridge is a verifying relayer |
| [`contracts/solana/BRIDGE_NTT_FEE_VALIDATION.md`](contracts/solana/BRIDGE_NTT_FEE_VALIDATION.md) | Wormhole NTT fee-validation notes. This does not deploy NTT |
| [`contracts/solana/STAKE_QUOTE_ORACLE_CONTRACT.md`](contracts/solana/STAKE_QUOTE_ORACLE_CONTRACT.md) | Oracle interface for the DAO-creation stake quote |

### Chain deployment records

Each folder holds that network's address manifests and Foundry broadcast logs. Solidity source stays in [`contracts/evm`](contracts/evm/README.md).

| Network | Folder |
| --- | --- |
| Ethereum mainnet (chain 1) | [`contracts/ethereum/mainnet`](contracts/ethereum/mainnet/README.md) |
| Ethereum Sepolia (`11155111`) | [`contracts/ethereum/sepolia`](contracts/ethereum/sepolia/README.md) |
| Base mainnet (`8453`) | [`contracts/base/mainnet`](contracts/base/mainnet/README.md) |
| Base Sepolia (`84532`) | [`contracts/base/sepolia`](contracts/base/sepolia/README.md) |
| Robinhood Chain (`4663`) | [`contracts/robinhood/mainnet`](contracts/robinhood/mainnet/README.md) |
| Robinhood Chain testnet (`46630`) | [`contracts/robinhood/testnet`](contracts/robinhood/testnet/README.md) |

---

## Product

A treasury on Nave has three layers of control.

1. **Constitution.** Members ratify approved venues, allocation caps, a liquidity floor, confidence thresholds, and cadence. Those rules are stored on-chain and are what capital movement is checked against.
2. **Agents.** Four roles — Executive, Financial, Oversight, and Operational — read treasury state, reason, and either approve, halt, or clear a pending action. A separate planner key can draft Strategy proposals. None of these keys can move funds by themselves.
3. **Programs.** Solana Anchor programs and EVM UUPS contracts execute only what the constitution and the pipeline allow. Value, caps, and pauses live on-chain. Postgres and the UI are projections of that state.

### What a member does

- Create a DAO on Base or Robinhood Chain. Quick setup starts from a conservative policy (stablecoin reserve, deployment cap, per-venue cap, liquidity floor). Solana and Ethereum creation paths are not the live create flow.
- Deposit assets into the treasury.
- Ratify or amend the constitution through governance.
- Vote on strategy proposals.
- Bridge and stake the protocol token (`NAVE` on Solana, `wNAVE` on EVM) on the Bridge and Stake surfaces. Those surfaces cover Solana plus the EVM families. Payout recipients come from the on-chain source event, not from the HTTP body.

### Chains

The closed set is Solana plus six EVM chain ids. There is no BNB, Polygon, or other EVM network in product scope.

| Family | Mainnet | Testnet | What it is for |
| --- | --- | --- | --- |
| Solana | mainnet-beta (bridge/stake tooling; DAO programs here are devnet) | devnet | Anchor DAO stack, NAVE SPL token, bridge lock/release, staking |
| Ethereum | `1` | Sepolia `11155111` | Sister yield destination and DAO stack. Founder create stays off Ethereum. |
| Base | `8453` | Base Sepolia `84532` | Live DAO-creation chain |
| Robinhood Chain | `4663` (Arbitrum Nitro L2) | `46630` | Live DAO-creation chain |

Deployment JSON and Foundry broadcast logs for each EVM network live in that chain's folder (`contracts/ethereum`, `contracts/base`, `contracts/robinhood`). Shared Solidity is in `contracts/evm`. `contracts/evm/deployments` and `contracts/evm/broadcast` are symlinks back to the chain folders so Forge still has one project root.

### Fees

On-chain `FeeConfig` is authoritative. The launch posture surfaced by cutover preflight is:

- **Performance fee:** 8.5% of realized yield (`performance_fee_bps = 850`), skimmed inline on strategy withdrawal. Principal is not taxed.
- **Management fee:** 0.65% per year of idle balance (`management_fee_bps = 65`), collected in-kind per registered asset on an annual UTC boundary.

Both pay a single protocol revenue wallet. That wallet needs a token account for every mint the treasury holds, or the skim fails on-chain.

Bridge fees are separate and enforced inside `nave_bridge` / the EVM lockbox (per-tx cap, rolling daily cap, pause, replay guard).

---

## How the system runs

```
Members (wallet)
    │  create / deposit / vote / bridge / stake
    ▼
On-chain programs  ──── events ────►  Indexers
Solana: Anchor                         Solana: Helius raw webhook
EVM: UUPS DAO + bridge                 EVM: app/evm-indexer (getLogs)
    ▲                                      │
    │ agent-signed txs                     ▼
    │                                 Supabase
Signer service  ◄── /sign ──────────  Postgres + edge functions
(Railway)         /bridge-relay       agent-orchestrator, policy-evaluator,
                  /staking-mirror     proposal-creator, index-events, …
    ▲
    └── decrypts agent keys per request (nothing on disk)

Web app (Vite, Vercel, root directory `app`)
    reads chain + Supabase, user signs their own transactions
```

| Layer | Where | Authority |
| --- | --- | --- |
| Web app | `app/src` | Display and user-signed transactions. Never the source of balances. |
| Backend | `app/supabase` | Indexed history, DAO metadata, agent orchestration. Custom bearer auth (`verify_jwt` off). |
| Signer | `app/signer-service` | Submits agent, bridge, and staking-mirror transactions. Holds no keys on disk. |
| EVM indexer | `app/evm-indexer` | Polls Ethereum, Base, and Robinhood logs into `index-events`. |
| Contracts | `contracts/` | Final authority for value, caps, pauses, and governance. |

Indexing is idempotent. Solana dedupes on transaction signature. EVM dedupes on `txHash:logIndex`. A missed webhook or poll self-heals on the next `snapshot-treasury` run.

---

## Repository map

```
nave-finance/
  app/                          Vite app, edge functions, signer, indexer
    src/                        React UI, chain clients, ABIs, IDLs
    supabase/functions/         Deno edge functions
    supabase/migrations/        Postgres schema
    signer-service/             Agent signer, bridge relayer, worker loops
    evm-indexer/                EVM log poller
    scripts/                    Cutover, secret sync, eval verifiers
    docs/                       Preflight, secrets, runbooks, audits, GenLayer boundary
  contracts/
    solana/                     Anchor workspace (programs, tests, deployments)
    evm/                        Foundry project (src, test, script, lib)
    genlayer/                   Intelligent contracts that review a move. They do not hold assets |
    ethereum/                   Chain 1 and Sepolia records
    base/                       Chain 8453 and Base Sepolia records
    robinhood/                  Chain 4663 and Robinhood testnet records
    src/lib/sdk/                Solana SDK helpers (PDAs, instructions)
```

### Solana programs (`contracts/solana/programs`)

| Program | Role | Checked-in id |
| --- | --- | --- |
| `nave_core` | Registry, vault accounting, agents, guardians, fees, constitution | `8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB` |
| `nave_governance` | Proposals, voting, quorum, finalization | `CwFouCjZyBrpLGuKvd9VXQqYh4ZYyT9yUQbqmo6k7n9M` |
| `nave_execution` | Four-agent approval pipeline and strategy execution | `2sGy7WwF6uGCyBmPqohRtobmutGhKjr2AG2FKvfcpYzb` |
| `nave_jito_adapter` | Jito strategy slot | `E2fviyVGWF8iEwZK2M8ysrd63DM5yKxu6nuBMzjBQ2XT` |
| `nave_kamino_adapter` | Kamino strategy slot | `B69DnA6h7B7MvLkNjRQDs4qDUbw9zrNwF9c8WuKo7kfD` |
| `nave_marginfi_adapter` | MarginFi strategy slot | `Gavh8GezswR14BYC851r6vevk267iWDfBkC3Fo49b1q7` |
| `nave_bridge` | NAVE lock/release. Closed mainnet id; do not redeploy this id | `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6` |
| `nave_staking` | NAVE stake pool. Closed mainnet id; pair with the bridge | `AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf` |

Anchor `0.32.1`. Public deployment records (RPC URLs replaced with `${SOLANA_RPC_URL}`) are in `contracts/solana/deployments/`.

### EVM contracts (`contracts/evm/src`)

Protocol singletons are UUPS proxies, handed to a Safe after deploy. Each DAO is three UUPS proxies: Treasury, Governor, Execution. Existing DAOs upgrade only through their own governance (`ProposalType.ContractUpgrade`).

| Contract | Role | Solana analogue |
| --- | --- | --- |
| `NaveProtocol` | Singleton config, DAO registry, implementation registry, fee sink | `NaveGlobalConfig` |
| `NaveDAOFactory` | `createDao` | DAO initialization |
| `NaveTreasury` | Custody, fees, assets, agents, guardians, constitution | `nave_core` (per DAO) |
| `NaveGovernor` | Proposals, voting, upgrade execution | `nave_governance` |
| `NaveExecution` | Four-agent pipeline and adapter calls | `nave_execution` |
| `PythOracle` | Pyth prices plus Chainlink fallback | oracle utils |
| `WrappedNave`, `NaveBridge`, `NaveStaking` | wNAVE, lockbox, stake | `nave_bridge`, `nave_staking` |
| `adapters/*` | Aave v3, Compound v3, Balancer v2 | Jito / Kamino / MarginFi adapters |

Addresses for a chain are the JSON files in that chain folder, for example `contracts/base/mainnet/8453.json` and `contracts/base/mainnet/evm-launch-8453.json`. The same files are visible through the symlinks in `contracts/evm/deployments/`.

---

## Agentic system

Agents are advisory. Deterministic guardrails and the programs decide what may be signed. The default model named by cutover preflight is `claude-sonnet-4-6` (`NAVE_AGENT_MODEL`). A fine-tuned override has to pass the scorecard in `app/docs/FINE_TUNING.md` before it is used.

GenLayer is a separate review of the same execution request on every chain. It is off until `NAVE_GENLAYER_GATE` is set. A finished review can stop a signature. It cannot approve a transfer or hold assets. See `app/docs/GENLAYER.md`.

### Roles

| Role | Job | On-chain effect |
| --- | --- | --- |
| Planner (`NAVE_PROPOSER_ROLE`, default `planner`) | Turns a policy recommendation into a Strategy proposal | Creates a proposal only. No approve or execute authority. Must be funded (pays rent / gas). |
| Executive | First review of an execution request | `executive_approve` moves `Pending` → `ExecutiveApproved` |
| Financial | Second review, bound to the proposal payload hash | `financial_approve` moves → `FinancialApproved`. Hash is SHA-256 of `proposal.payload[0 .. payload_len]`. |
| Oversight | Third review | `oversight_approve` moves → `OversightApproved` / `InReview` |
| Operational | Executes inside the review window, or halts | `execute_strategy` after the window, or `operational_halt` / `operational_clear` |

The orchestrator maps request status to the next role (`Pending` → executive, `ExecutiveApproved` → financial, `FinancialApproved` → oversight, `OversightApproved` / `InReview` / `Halted` → operational). `Executed` and `Expired` are terminal. A halt stays with Operational so it can be cleared. `NAVE_EXECUTION_GRACE_SECS` (default 24h) is how long a non-executable Operational verdict can park a request before it expires.

### One cycle

1. **Policy.** `policy-evaluator` reads treasury state and the constitution. The signer worker calls it on `POLICY_INTERVAL_MS` (default 10 minutes).
2. **Propose.** `proposal-creator` runs on `PROPOSAL_INTERVAL_MS` (default 10 minutes). With `NAVE_AUTOPROPOSE_ENABLED` unset or `false`, it only reports candidates. With it `true`, the planner key submits Strategy proposals. Withdraw legs also require `NAVE_AUTOPROPOSE_WITHDRAW_ENABLED=true`. Compound stays behind `NAVE_COMPOUND_ENABLED` (default `false`).
3. **Vote.** Members vote in `nave_governance` / `NaveGovernor`. Finalizing a proposal does not by itself create an execution request.
4. **Execution request.** A strategy (or other) path opens an execution request. That is what the four-agent pipeline walks.
5. **Reason.** `agent-dispatcher` runs one role's reasoning step, under `NAVE_AGENT_SECRET`.
6. **Orchestrate.** `agent-orchestrator` is not on `pg_cron`. Something POSTs it with `mode: "poll"` or `mode: "manual"`: the signer worker (`ORCHESTRATOR_INTERVAL_MS`), `index-events` after governance or agent events, `orchestrator-proxy`, or a founder-gated poll from the Governance UI after a Solana constitution ratify.
7. **Constitution gate.** Before any capital signer call, `assessSignerPayload` loads the on-chain constitution (Solana via `onchain.ts`, EVM via `evmPolicy.ts`) and runs `evaluateGuardrails` with `failClosedOnUnknown` and `requireCompleteConstitution`. A failed or indeterminate critical check is stored on `constitution_check` and the signer is not called. Accounting-only updates (revalue, mark) are allowed with amount moved `0`.
8. **Sign.** The orchestrator POSTs `app/signer-service` `/sign` with `X-Signer-Secret`. The signer decrypts that role's key from `encrypted_agent_keys`, simulates, checks a writable-account allowlist, and submits. A completed pass writes `agent_action_logs` with `action_type = "signing"`.

`NAVE_GUARDRAILS_FAIL_CLOSED` fails closed unless it is the literal string `"false"`. Mainnet preflight refuses cutover when it is `"false"`.

### Keys

Agent signing keys are generated per DAO by `generate-agent-keys` / `generate-evm-agent-keys` after a wallet-signature check. Each key is encrypted with AES-256-GCM. A per-DAO data key is wrapped by `NAVE_MASTER_KEK` (base64, 32 bytes) and stored on `encrypted_agent_keys`. The signer and the edge functions unwrap with the KEK at request time. Rotate the KEK with `app/scripts/rotate-kek.mjs` (re-wrap every DEK, then swap the env var). Rotating an agent keypair is a separate step: insert a new active row and set the old row `is_active = false`.

The planner key is a real key in the same table. Keep it distinct from the four pipeline roles.

Bridge and faucet keys are different and are raw env secrets on the signer host, not envelope-wrapped:

- `BRIDGE_SOLANA_RELAYER_AUTHORITY` may call Solana `release` only, inside pause and caps.
- `BRIDGE_EVM_MINTER_PRIVATE_KEY` may call lockbox `bridgeIn` only, inside pause, caps, and the replay map.
- `FAUCET_WALLET_SECRET` is a devnet faucet key. `FAUCET_ENABLED` must not be `true` on mainnet.

Admin ownership (Solana upgrade authority, bridge `owner`, EVM Safe) is meant to sit on a multisig, separate from the relayer hot key. See `app/docs/RUNBOOKS.md` and `contracts/CUTOVER.md`.

### Signer worker loops

`app/signer-service/railway.json` starts `worker.ts` beside the HTTP server. Loops take a Postgres lease (`worker_locks`) so a second replica does not double-send.

| Loop | What it does |
| --- | --- |
| Orchestrator poll | POST `agent-orchestrator` `{ mode: "poll" }` |
| Policy / proposal ticks | POST `policy-evaluator` and `proposal-creator` |
| Bridge watcher | Re-drive `pending` / `failed` bridge rows, then park `stuck`. Scan for lock/burn events that never got a row. |
| Staking mirror | Split the Solana staking-fee collector by live stake weight into the Solana reward vault and each EVM `notifyReward` |
| Management fee | After `NAVE_OPS_WALLET_SECRET` is set, collect the annual management fee shortly after each asset's UTC boundary (`MANAGEMENT_FEE_INTERVAL_MS`, default 1 hour). A tick with nothing due is a no-op. |
| Agent SOL top-up | Refill agent keypairs from the ops wallet when they fall through the request / operate / fill thresholds |

Public HTTP on the signer (`/bridge-relay`, `/faucet-claim`) does not accept the signer secret. Those routes re-read the source transaction on-chain. `/sign` requires `X-Signer-Secret`.

### What operators watch

- `agent_action_logs` for `signing` / `completed` and a real transaction signature.
- `constitution_check` on refused capital actions.
- `bridge_transfers` status (`pending`, `failed`, `stuck`, `completed`) and `GET /bridge-queue` on the signer.
- Edge logs for `agent-orchestrator`, `agent-dispatcher`, `policy-evaluator`, `proposal-creator`.
- Signer `GET /health` (no secrets in the body).

Eval gates before turning autonomy on, from `app/`:

```bash
npm run eval:ci          # agent contracts, guardrails, decisions, fine-tune scorecard
npm run typecheck:eval
npm run beta:go-no-go
```

---

## Local development

**Toolchain.** Node.js 20+ (signer CI uses Node 22). Anchor `0.32.1` via `avm`. Solana CLI. Foundry (`forge`, `cast`). Supabase CLI for functions and migrations. A Solana wallet and an EVM wallet for the chains you exercise.

### App

```bash
cd app
npm ci
cp .env.example .env.local
npm run dev
```

`VITE_` variables are public in the browser bundle. Required to boot: `VITE_SOLANA_RPC_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and the program ids in `.env.example`. The anon key is a client credential, still supplied per environment rather than baked into source. Service-role keys, bearer secrets, and private keys stay out of `VITE_` names.

```bash
npm run typecheck
npm run test:frontend
npm run build             # typecheck, then Vite
```

`npm run sync-idl` copies Anchor IDL from `contracts/solana/target` after `anchor build`. `npm run sync-abi` copies Foundry ABIs from `contracts/evm/out` after `forge build`.

### Contracts

```bash
cd contracts
npm ci
npm run test:unit

cd solana
cargo test --workspace
# local validator suite (needs Solana CLI + Anchor)
anchor test

cd ../evm
forge build
forge test                # fork tests skip when RPC URLs are empty
```

Forge RPC endpoints are environment variables listed in `contracts/evm/foundry.toml` (`ETH_MAINNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, `EVM_ROBINHOOD_RPC_URL`, and the testnet equivalents). Do not put keyed URLs in `foundry.toml`.

### Signer and indexer

```bash
cd app/signer-service
cp .env.example .env
npm ci
npm run dev               # GET http://localhost:<PORT>/health

cd ../evm-indexer
npm ci
# set chain RPC URLs and NAVE_INDEXER_SECRET, then start the poller
```

IDL lookup in the signer is `IDL_DIR`, then `signer-service/idl`, then `app/src/idl`.

---

## Deploy

Do this in order. Each host gets only the secrets it needs. Generate distinct bearers with `cd app && npm run secrets:generate` (`openssl rand -hex 32` per secret). Inventory and rotation steps are in [`app/docs/SECRETS.md`](app/docs/SECRETS.md).

### 1. Contracts

Record every address in the chain folder for that network. Symlinks under `contracts/evm/deployments/` must keep resolving.

Solana (devnet iteration, from `contracts/`):

```bash
npm run deploy:devnet
```

Mainnet program deploys go through the cutover scripts, not a fresh `solana program deploy` of the closed bridge and staking ids. Upgrade authority for the six DAO programs is intended to move to a Squads multisig (threshold at least 2 of 3).

EVM (from `contracts/evm`, after `forge build`):

```bash
PROTOCOL_OWNER=0x... PROTOCOL_TREASURY=0x... PYTH_ADDRESS=0x... \
FORMATION_FEE_WEI=... TOKEN_MINT_FEE_WEI=... \
forge script script/Deploy.s.sol --rpc-url <chain> --broadcast
```

Then hand UUPS ownership to the Safe (`acceptOwnership` on protocol, factory, oracle, stake, and the bridge stack). Publish DAO implementations with `script/PublishDaoImpls.s.sol` so new logic does not mutate live DAOs until they pass a `ContractUpgrade` proposal.

Preferred path for Base and Robinhood is the app cutover driver (next section), which calls `contracts/solana/scripts/evm-mainnet-cutover.mjs`.

### 2. Supabase

From `app/`, with the CLI linked to the project in `app/supabase/config.toml`:

```bash
supabase db push
supabase functions deploy
npm run secrets:sync-edge-rpc    # copies RPC URLs and NAVE_INDEXER_SECRET from .env.local
```

Edge secrets:

| Secret | Who shares it |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Edge functions and the signer |
| `NAVE_INDEXER_SECRET` | `helius-webhook`, `index-events`, `snapshot-treasury`, EVM indexer |
| `NAVE_AGENT_SECRET` | `agent-orchestrator`, `agent-dispatcher`, `agent-health` |
| `NAVE_SIGNER_URL`, `NAVE_SIGNER_SECRET` | Orchestrator → signer `/sign` |
| `NAVE_POLICY_SECRET` | `policy-evaluator` and the worker policy tick |
| `NAVE_PROPOSER_SECRET` | `proposal-creator` and the worker proposal tick |
| `NAVE_MASTER_KEK` | Edge functions and the signer |
| `SOLANA_RPC_URL` and `EVM_*_RPC_URL` | Server-side reads. No API keys in the repo. |

`snapshot-treasury` also runs once per 24 hours at 00:00 UTC from `pg_cron` via `pg_net`, with secrets in Supabase Vault. SOL price comes from CoinGecko and falls back to `price_cache`.

Helius webhook (Solana):

- URL: `https://<project>.supabase.co/functions/v1/helius-webhook`
- Type: Raw
- Authorization header: `NAVE_INDEXER_SECRET` (`Authorization` or `X-Indexer-Secret`). Do not put the secret in the query string; Supabase logs query params.
- Accounts: the program ids in the table above, plus bridge and staking ids when those programs are the ones you intend to index.

```bash
curl "https://<project>.supabase.co/functions/v1/helius-webhook?selftest=1"
curl "https://<project>.supabase.co/functions/v1/index-events?health=1"
curl "https://<project>.supabase.co/functions/v1/snapshot-treasury?health=1"
```

### 3. Signer (Railway or any container host)

Build from `app/signer-service` (`Dockerfile`, health check `GET /health`). The start command runs the worker and the HTTP server together.

Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NAVE_SIGNER_SECRET` (same value as the edge secret), `SOLANA_RPC_URL`, chain RPC URLs for every EVM network the relayer serves, `NAVE_MASTER_KEK`. Add bridge keys only when that corridor is intentionally on. On mainnet, preflight also requires `NAVE_CLUSTER=mainnet`, Upstash Redis (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) because the signer refuses to sign when the rate limiter cannot reach Redis, and `NAVE_SIGNER_SKIP_SIMULATION` left unset.

Point edge secrets at the host:

```
NAVE_SIGNER_URL=https://<signer-host>    # no /sign suffix
NAVE_SIGNER_SECRET=<same value>
```

```bash
curl -s https://<signer-host>/health
curl -s -X POST "$SUPABASE_URL/functions/v1/agent-orchestrator" \
  -H "X-Agent-Secret: $NAVE_AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"poll"}'
```

### 4. EVM indexer

Deploy `app/evm-indexer` as its own service. It needs `NAVE_INDEXER_SECRET`, Supabase credentials, and an RPC URL per chain it should poll. Cursors live in `evm_indexer_cursors`. Set `NAVE_EVM_START_BLOCK_<chainId>` to backfill; otherwise the first run starts at the chain head.

### 5. Web app (Vercel)

Set the Vercel project root to **`app`**. Production env is the `VITE_` set from `.env.example` plus the addresses written by cutover (`VITE_EVM_BASE_*`, `VITE_EVM_ROBINHOOD_*`, program ids). Redeploy after changing any `VITE_` variable; Vite inlines them at build time.

`app/vercel.json` rewrites every path to `index.html` for the client router.

### 6. Turn a DAO on

After create and constitution ratification:

1. Confirm `register-dao` wrote metadata and `generate-agent-keys` wrote four active rows (plus the planner row if you will autopropose).
2. Fund each agent key with SOL or gas for the chain it signs on.
3. Leave `NAVE_AUTOPROPOSE_ENABLED` false until `npm run eval:ci` and the devnet E2E gate in `app/docs/DEVNET_E2E_GATE.md` have been accepted for that environment.
4. Watch one manual poll end in an `agent_action_logs` signing row before enabling the worker interval.

---

## Cutover and day-2 operation

Base + Robinhood contract cutover, from `app/`:

```bash
npm run cutover:base-rh:validate
npm run cutover:base-rh -- --phase all --env /secure/path/secrets.env --confirm-mainnet
```

The command reads operator inputs from `app/DEPLOYMENT_DATA.md`, deploys through the contracts scripts, and writes `app/deployments/cutover-base-rh.env.generated`. Merge that snippet into Vercel and Railway. It contains addresses, not keys.

Full platform cutover (Solana programs, EVM, authority handoff) is the wizard. It never asks for a private key. Signatures stay in the Solana CLI, a Foundry keystore, or a hardware wallet.

```bash
cd app
npm run mainnet:preflight
npm run mainnet:wizard                 # dry run, no subprocesses
npm run mainnet:wizard:rehearse        # testnet rehearsal
npm run mainnet:wizard:live            # requires --confirm-mainnet on the underlying script
```

Copy `app/.env.mainnet.cutover.example` to a path outside the repo and fill it there. The schema is `app/scripts/mainnet-cutover-env.schema.json`. Refuse to proceed unless `NAVE_AGENT_SECRET`, `NAVE_SIGNER_SECRET`, and `NAVE_INDEXER_SECRET` are distinct, `NAVE_GUARDRAILS_FAIL_CLOSED` is not `"false"`, the revenue wallet is funded, and revenue-wallet token accounts exist:

```bash
cd app
npm run provision:revenue-atas:dry
npm run provision:revenue-atas
```

Ongoing checks:

```bash
cd app
npm run beta:health-report
npm run verify:e2e-gate          # needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DAO_ADDRESS
```

GitHub Actions at `.github/workflows/` run app typecheck and tests (`app/`) and contract unit tests (`contracts/`). Paths are rooted at the monorepo, not at `app/` or `contracts/` alone.

### Secrets

Never commit `.env`, `.env.local`, private keys, mnemonics, service-role keys, or RPC URLs that contain API keys. Examples (`*.example`) are placeholders.

- App: `app/.env.example` → `app/.env.local`
- Mainnet operator file: kept outside git, shaped like `app/.env.mainnet.cutover.example`
- Solana deploy wallets: gitignored beside `contracts/solana/` (`.deploy-wallet*`, `.staking-collector*`)
- EVM deploy wallet: `contracts/evm/evm-deploy-wallet.json` (gitignored) or a Foundry keystore (`EVM_DEPLOY_ACCOUNT`)

Rotation order is in [`app/docs/SECRETS.md`](app/docs/SECRETS.md). Rolling `SUPABASE_SERVICE_ROLE_KEY` or `NAVE_MASTER_KEK` needs a maintenance window. Rolling a bearer means updating Supabase secrets and Railway in the same change, then probing health before the old value is discarded.

---

## Documentation

The full index is [Documentation map](#documentation-map) at the top of this file. It links the product portal, launch runbooks, agent gates, service READMEs, contract audits, and each chain's deployment folder.
