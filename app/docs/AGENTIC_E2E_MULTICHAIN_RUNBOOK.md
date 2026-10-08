# Agentic multichain E2E (Solana devnet + Sepolia + Base Sepolia)

## Before mainnet (operator / AI handoff)

Treat **devnet-era** material (keys that ever lived in chat, shared `.env`
snippets, or convenience copies where `NAVE_AGENT_SECRET` /
`NAVE_SIGNER_SECRET` / `NAVE_INDEXER_SECRET` were identical) as **not reusable**
for mainnet without explicit rotation.

When work shifts to **mainnet cutover**, expect to **stop and supply fresh**
secrets (Supabase service role handling, distinct `NAVE_*` bearer secrets,
`ANTHROPIC_API_KEY`, custodial wallets, production RPC URLs). Automated or
assistant-driven mainnet steps should **not** proceed on assumed or historical
credentials — only on keys you provide for that phase.

This runbook matches the **product QA** goal: DAO formation, ratified constitution,
conservative limits, autonomous four-agent pipeline (Claude Sonnet via
`agent-dispatcher`), real strategy deploy and unwind, treasury transfer proposals,
token authority changes, agent pause, stable deposits (e.g. PYUSD where
available), and privacy settings — on **Solana devnet** and **both** EVM
testnets.

It complements the evidence-heavy Solana gate in
[`DEVNET_E2E_GATE.md`](./DEVNET_E2E_GATE.md) and the infra checklist in
[`DEVNET_MULTICHAIN_BETA_E2E.md`](./DEVNET_MULTICHAIN_BETA_E2E.md).

## Resumable checkpoints (stop on bug, continue after fix)

Do **not** restart the whole manual flow after each bug. Use the checkpoint tool:

```bash
cd /path/to/nave-app
npm run agentic-e2e:preflight   # optional: confirm .env.example + .env.local key *names* only
npm run agentic-e2e:checkpoint -- init          # once per campaign
npm run agentic-e2e:checkpoint -- set-dao solana <base58-pubkey>
npm run agentic-e2e:checkpoint -- set-dao evm_sepolia 0x…
npm run agentic-e2e:checkpoint -- set-dao evm_base_sepolia 0x…
npm run agentic-e2e:checkpoint -- status
npm run agentic-e2e:checkpoint -- complete S1.3 # after each step passes
npm run agentic-e2e:checkpoint -- bug "short repro + error text"
npm run agentic-e2e:checkpoint -- note S3.1 "execute tx 5ubn4F…"
npm run agentic-e2e:checkpoint -- next          # lowest pending step
npm run agentic-e2e:checkpoint -- report         # paste into PR/issue
```

CI or assistants can smoke the tool without touching your default state file:

```bash
AGENTIC_E2E_STATE_FILE=/tmp/agentic-e2e-ci-state.json \
  npm run agentic-e2e:checkpoint -- reset && \
AGENTIC_E2E_STATE_FILE=/tmp/agentic-e2e-ci-state.json \
  npm run agentic-e2e:checkpoint -- init && \
AGENTIC_E2E_STATE_FILE=/tmp/agentic-e2e-ci-state.json \
  npm run agentic-e2e:checkpoint -- status
```

State file: `test-results/agentic-e2e-state.json` (gitignored). Override with
`AGENTIC_E2E_STATE_FILE` if you need multiple parallel runs.

## Model and policy (success criteria)

- Edge function `agent-dispatcher` uses `ANTHROPIC_API_KEY` and
  `NAVE_AGENT_MODEL` (default **`claude-sonnet-4-6`** per code and
  [`MAINNET_PREFLIGHT.md`](./MAINNET_PREFLIGHT.md)).
- Training-field completeness after a run:
  - **One command** (loads `.env.local`, uses `VITE_SUPABASE_URL` / `VITE_SOLANA_RPC_URL` / checkpoint `daoAddresses.solana` fallbacks where supported):

    ```bash
    npm run verify:agentic-e2e-suite
    ```

  - Or explicitly:

    `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… DAO_ADDRESS=… SOLANA_RPC_URL=… npm run verify:e2e-gate`
- Deterministic guardrails in `agent-dispatcher` still apply; the model must not
  contradict a closed agent gate.

**Yield:** On **devnet**, “real yield” is protocol-dependent (many legs are
1:1 or fee-only). Treat **material SPL/ERC-20 movement + correct fee skim +
reconciliation** as the pass bar; treat **mainnet APR** as out of scope for
this gate.

## Solana (devnet)

Follow **§0–§5** of [`DEVNET_E2E_GATE.md`](./DEVNET_E2E_GATE.md) for the
canonical autonomous pipeline, escrow reconciliation, and
`agent_action_logs`. Map checkpoint ids **S\*** in the checkpoint script to those
sections.

- **Constitution / conservative settings:** use app flows (Create DAO →
  Governance / Policy) so on-chain `set_policy_parameters` matches your
  conservative BPS caps; ratify as required by your deployment.
- **DAO creation evidence:** for wallet-governance DAOs, `S1.1` is satisfied by
  the `dao_registry` row plus on-chain `DaoRegistry` / `GuardianConfig`
  authorized-wallet evidence. A `TokenRegistry` entry is only required for
  token-governance DAOs or explicit DAO-token flows.
- **Pause agents:** Settings / Agent page — confirm `toggle_agents(false)` and
  that the orchestrator does not advance while disabled (see gate **§6d**).
- **Token mint + revoke:** follow the Solana token flow your deployment exposes
  (mint authority / freeze if applicable); capture signatures in checkpoint
  `note` fields.
- **PYUSD / stables:** devnet mints differ from mainnet; use whatever the team
  has allowlisted, or a standard devnet USDC, and record mint + deposit tx in
  `note`.

## EVM (Sepolia `11155111` and Base Sepolia `84532`)

- Deploy / env: [`DEVNET_MULTICHAIN_BETA_E2E.md`](./DEVNET_MULTICHAIN_BETA_E2E.md).
- **Wallet UI** (Create DAO, votes, execution pipeline) still requires **manual
  wallet QA** or a future Synpress stack — Playwright smoke does not sign txs.
- **Local substitute** when RPC/funds are unavailable — Foundry E2E (same
  lifecycle logic on a mock adapter):

  ```bash
  # From nave-app (auto-detects sibling nave-contracts on this machine layout):
  npm run agentic-e2e:forge

  # Or explicitly:
  NAVE_EVM_CONTRACTS_DIR=/path/to/contracts/evm \
    npm run agentic-e2e:forge
  ```

- **On-chain EVM helpers** in the app: see `src/lib/evm/writers.ts` for
  `revokeTokenAuthority`, `setDaoPrivacy`, and agent/treasury actions aligned
  with your DAO role keys.

## Multichain read-only verifier

After EVM DAOs exist in `dao_registry`:

```bash
export SUPABASE_URL=…
export SUPABASE_SERVICE_ROLE_KEY=…
export EVM_SEPOLIA_RPC_URL=…
export EVM_BASE_SEPOLIA_RPC_URL=…
export VITE_EVM_SEPOLIA_FACTORY_ADDRESS=0x…
export VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS=0x…
# optional strict gate:
export REQUIRE_EVM_DAOS=true
npm run verify:devnet-multichain
```

## Full pass workflow (after bugs fixed)

1. `npm run agentic-e2e:preflight` (optional — confirms `.env.example` coverage + `.env.local` key names)
2. `npm run agentic-e2e:checkpoint -- reset && npm run agentic-e2e:checkpoint -- init`
3. Execute **S\*** then **E\*** then **B\*** in order (or parallelize EVM chains
   with two state files via `AGENTIC_E2E_STATE_FILE` if operators are different).
4. Run `npm run verify:agentic-e2e-suite` (or run `verify:e2e-gate` per Solana DAO,
   then `verify:devnet-multichain`, then `agentic-e2e:forge` separately).
5. `npm run agentic-e2e:checkpoint -- report` → attach to release notes.

If anything fails in the final full pass, **stop**, log `bug`, fix, resume from
`next` — do not loop the entire suite blindly.

### Troubleshooting `verify:agentic-e2e-suite`

- **`verify:e2e-gate` — “no agent model traces for this DAO”**  
  The Solana address in `DAO_ADDRESS` or `test-results/agentic-e2e-state.json` →
  `daoAddresses.solana` has no rows in `agent_action_logs` with a non-empty
  `claude_model` (only indexer echoes such as `toggle_agents` reconciliation do
  not count). Drive the Phase 5 autonomous pipeline on that DAO (see
  [`DEVNET_E2E_GATE.md`](./DEVNET_E2E_GATE.md) §2–§5), **or** temporarily set
  `DAO_ADDRESS` to a DAO that already has graded traces when you only need to
  re-verify logging.

- **`verify:devnet-multichain` with `REQUIRE_EVM_DAOS=true`**  
  Fails if `dao_registry` has no row for **both** chain ids `11155111` (Sepolia)
  and `84532` (Base Sepolia). Register a Base Sepolia DAO (app + wallet) before
  expecting a strict multichain pass for the **B\*** checkpoint block.
