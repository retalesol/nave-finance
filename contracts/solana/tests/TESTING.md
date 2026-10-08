# Nave Smart Contract Tests

## Quick start

```bash
# From repo root (install deps once)
npm install

# Pure unit + scenario simulations (no validator required)
npm run test:unit

# Full on-chain integration (single long run — use after fixes are done)
npm run test:localnet
```

## Devnet (live Solana)

Requires `.deploy-wallet-devnet.json` and RPC in `.env.testnet.local` (see `.env.testnet.example`).

```bash
# From repo root
npm run test:devnet:solana:smoke   # devnet-e2e.ts only
npm run test:devnet:solana:full    # e2e + revalue + CPI scripts

# EVM testnets (Sepolia / Base Sepolia) — skips unless --live and funded
npm run test:devnet:evm -- --chain-id 11155111
npm run test:devnet:evm:live -- --chain-id 84532
```

Devnet-specific scripts (`*-devnet.ts`) are excluded from localnet checkpoint runs (see `Anchor.toml` and `generate-test-manifest.mjs`).

## Incremental localnet runs (recommended while fixing failures)

Avoid restarting the full suite after every fix. Use the checkpoint runner against a **persistent localnet session**.

### 1. Start localnet once per dev session

```bash
cd solana
npm run localnet:up          # starts validator, builds + deploys programs
```

### 2. Build test manifest (after adding/renaming tests)

```bash
npm run test:manifest        # writes .test-runs/manifest.json
```

### 3. Run with checkpointing

```bash
npm run test:checkpoint      # runs from last progress (or index 0)
```

Each passing test is appended to `.test-runs/success.log` and `.test-runs/checkpoint.json` is updated.

### 4. Resume after a failure (5–8 tests overlap by default)

When a test fails, the runner stops and records the failure index. Resume from **6 tests before** the failure:

```bash
npm run test:resume
npm run test:resume -- --overlap 8    # wider overlap if stateful tests need it
npm run test:checkpoint -- --from 42  # explicit start index
```

### 5. Check progress

```bash
npm run test:checkpoint:status
tail -f .test-runs/success.log
```

### 6. Final verification (after all fixes)

```bash
npm run test:checkpoint:reset
npm run test:checkpoint:full   # reset + manifest + full checkpoint run
# or the traditional single-shot run:
npm run test:localnet
```

### Stop localnet

```bash
npm run localnet:down
```

## Checkpoint files

| Path | Purpose |
|------|---------|
| `.test-runs/manifest.json` | Ordered list of discovered tests + grep patterns |
| `.test-runs/checkpoint.json` | Last passed/failed index for resume |
| `.test-runs/success.log` | Append-only log of passing tests |
| `.test-runs/last-run.log` | Output from the most recent single test |

## Test layout

| File | Type | Coverage |
|------|------|----------|
| `tests/helpers/governance-math.ts` | Library | 35% quorum, majority-of-participants rules |
| `tests/helpers/apy-simulator.ts` | Library | Simulated DeFi APY 3%–12%, allocation caps |
| `tests/helpers/nave-harness.ts` | Library | DAO setup, voting, agents, guardians |
| `tests/governance-quorum-scenarios.ts` | Unit | Quorum math, DAO preset matrix |
| `tests/treasury-apy-scenarios.ts` | Unit | APY bands, cap splits, monthly accrual |
| `tests/scenario-simulation.ts` | Unit | Chen family narrative, edge cases, treasury sizes |
| `tests/treasury-governance-integration.ts` | Integration | Deposits, voting, strategy deploy, yield harvest |
| `tests/agent-protection-scenarios.ts` | Integration | Rogue agents, pipeline guards, review window |
| `tests/guardian-emergency-scenarios.ts` | Integration | M-of-N freeze/unfreeze, break-glass execute |
| `tests/nave-security.ts` | Integration | Original security smoke tests |
| `tests/claude-agent-backend.ts` | Integration | Agent rotation and dispatcher/orchestrator contracts |
| `tests/beta-path-scenarios.ts` | Integration | `execute_strategy` / `withdraw_from_strategy` / `expire_request` beta path |
| `tests/devnet-e2e.ts` | Devnet | Live-network smoke validation (not localnet default) |

Devnet-specific scripts (`*-devnet.ts`) should be run intentionally and kept out of default localnet loops.

## Governance model under test

- **Quorum:** `quorum_bps = 3500` → 35% of token supply must participate (`votes_for + votes_against`)
- **Passing:** `votes_for > votes_against` among participants (simple majority)
- **Abstain:** does not count toward quorum

## Simulated DeFi yield

Integration tests validate strategy accounting and agent pipeline behavior. Yield simulation flow:

1. Deploy capital via agent pipeline
2. Compute yield off-chain (`simulateYield`, up to 12% APY)
3. Mint harvest into vault via `deposit_to_vault` (simulated unwind)

## Integration test note

Many integration tests bypass the 24h review window by temporarily disabling agents (`toggle_agents(false)`) and using `execute_strategy_direct` — the same break-glass path available when agents are disabled or the DAO is frozen. `beta-path-scenarios.ts` adds coverage for the standard `execute_strategy` and unwind/expire flow.

## IDL generation

Integration tests require full Anchor IDLs in `solana/idl/`. Use Anchor 0.32.1:

```bash
avm use 0.32.1
cd solana && anchor build
cp target/idl/*.json idl/
```
