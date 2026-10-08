# Journey smoke — 2026-10-01

Phase 3 rehearsal from the sell-readiness plan (`smoke-the-journey`). Testnet reads and existing checklist scripts only. No Solana mainnet or EVM mainnet transaction was sent. `bridgeBurn`, bridge-relay, and `lock` were not called against program `Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`. Mainnet contract deploys were not run. `scripts/smoke-create-dao-base.mjs` was not run: it targets Base mainnet (chain id 8453).

Probed around **2026-10-01T10:05Z**.

## Verdict

The founder journey did not land. No transaction was broadcast in this pass, so there is no new signature. Create, deposit, constitution, and the agent pipeline are blocked on Base Sepolia and Robinhood testnet before a wallet prompt.

`VITE_NAVE_DAO_CREATION_STAKE_USD` is **19**. The Base Sepolia protocol the app points at reports `requiredNaveStake = 0`, with `naveStakeToken` and `daoStake` both `0x0`. That amount does not match $19. The price oracle is fail-closed, so there is no live NAVE quantity for $19 either.

## Deno typecheck

Deno 2.1.4 is installed at `~/.deno/bin/deno` (not on the default `PATH`).

| File | Result |
|---|---|
| `supabase/functions/_shared/evmPolicy.ts` | pass |
| `supabase/functions/proposal-creator/index.ts` | pass |
| `supabase/functions/agent-orchestrator/index.ts` | pass |
| `supabase/functions/policy-evaluator/index.ts` | fail |

`policy-evaluator` fails with 5 `TS2322` errors in `supabase/functions/_shared/poolScanner.ts`: `"sol"` is not assignable to `AssetClass`. Those errors are in the yield scanner the evaluator imports, not in `evmPolicy.ts`.

## Rehearsal scripts

| Script | Result |
|---|---|
| `npm run agentic-e2e:preflight` | pass. Curated keys are documented. `.env.local` is missing `DAO_ADDRESS`, `SOLANA_RPC_URL`, `EVM_SEPOLIA_RPC_URL`, and `EVM_BASE_SEPOLIA_RPC_URL` (Vite fallbacks for the RPC and Supabase URL are set). The preflight helper did not find `nave-contracts` on its default path. |
| `npm run verify:devnet-multichain` | fail (exit 2). Both configured testnet RPCs returned `fetch failed` in that run. A follow-up probe: Base Sepolia host answers chain id **84532**; the Sepolia Alchemy host does not resolve (`ENOTFOUND`). The script stops before the `dao_registry` query when any RPC check fails. |
| `npm run beta:go-no-go` | pass with two warnings. Edge `index-events` and `snapshot-treasury` health checks succeeded. `NAVE_SIGNER_URL` is unset. `DAO_ADDRESS` is unset, so `verify-e2e-gate` was skipped. |
| `scripts/evm-testnet-dao-e2e.sh 84532` | pass as a checklist. `forge build` succeeded. No broadcast. Adapter artifact zeros: `balancerAdapter`, `compoundV3Adapter`. Aave is set. |
| `run-evm-testnet-suite.mjs --chain-id 84532 --live` | skipped on purpose. The runner refuses Base Sepolia live mode because Foundry cannot fork OP Isthmus blocks (`EVM_TESTNET_SKIP_BASE_SEPOLIA` defaults to true). |

Chain ids **1**, **8453**, and **4663** were not used for any call that could move funds. Local RPC classification only: the Base mainnet URL answers 8453 and the Robinhood mainnet URL answers 4663. The Sepolia checklist (`11155111`) was not run because that RPC host does not resolve. `evm-testnet-dao-e2e.sh` rejects chain id 46630, so Robinhood testnet was read with `eth_chainId` / `eth_getCode` only.

## Journey

Stake target used for the comparison: `VITE_NAVE_DAO_CREATION_STAKE_USD=19`.

### Connect / create — blocked

Not sent.

The app's Base Sepolia factory `0x50693cB4DcF581b1FbfAA3138A21e81579d192C9` and protocol `0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02` both have code. `daoCount` is **1**. `formationFee` is 0. Owner is `0x6695C652a79329658440CDAf53aB640f95D5E06D`.

One `DaoCreated` log already exists on that factory. It was not produced by this smoke:

- tx `0x25db3faffbc7a8239d1ef11c3a14e0a4f2bacd98e7fcf0e99ada07261a1ca313`
- block 44684695
- treasury `0x68841c6490bdcda07de3672644a28cdd51eb34fe`
- governor `0x776d694f400cb969ec0e4e1d680a3ae0b48e22b0`
- execution `0xbc18e3565065040e433f0fc17e98b18190b09314`

`dao_registry` has one row on chain id 11155111 and **none** on 84532 or 46630.

Deployer `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca` has about **0.0124 ETH** on Base Sepolia and **0 wNAVE** (`0xa2DF37f136CA9eaFBA2c3D3D84834E5cb0113B1F`, 6 decimals). The live Base Sepolia suite is skipped by Foundry. Creating a DAO here would not lock a $19 stake.

### Stake matches $19 — blocked

On the app protocol:

- `requiredNaveStake = 0`
- `naveStakeToken = 0x0`
- `daoStake = 0x0`

`GET /functions/v1/nave-price-oracle` returned **503**: `oracle fail-closed: 0 healthy NAVE market sample(s) < required 1`. No base-unit quote was issued, so the screen amount and the chain amount cannot be shown as the same figure.

### Deposit — blocked

Not sent. Create did not run, and the deployer holds 0 wNAVE on Base Sepolia.

### Constitution excluding `0x0` adapters — blocked

Not sent.

`deployments/adapters-84532.json` lists Aave `0x536e2EB2f96fe419a893CDbE39E41e44326E60dA` (code present) and Balancer and Compound as `0x0` (no code). The existing treasury's `getApprovedAdapters()` is four empty arrays, so it does not list `0x0` and it also does not list the Aave adapter. Nothing was ratified in this pass.

### Agent pipeline — parked, not run

Not invoked. There is no Base Sepolia or Robinhood testnet row in `dao_registry`, `NAVE_SIGNER_URL` is unset, and `NAVE_POLICY_SECRET` is unset. The oracle is fail-closed, so a keeper quote for NAV or the creation stake is not available.

Honest parked reason: the pipeline has no testnet DAO to score and no signer URL to relay an execution. `policy-evaluator` also fails `deno check` on the `poolScanner` `AssetClass` errors above, so that function is not a clean gate.

## Robinhood testnet (46630)

RPC answers chain id **46630**. Launch artifact `evm-launch-46630.json` is bridge-and-stake only (`naveStake: null`, no factory). App env has no `VITE_EVM_ROBINHOOD_TESTNET_FACTORY_ADDRESS` or `VITE_EVM_ROBINHOOD_TESTNET_PROTOCOL_ADDRESS`.

Code is present (76 bytes, proxy-sized) at bridge `0x3aEB011526a6fC6f88a4068094CBA214F3d95B63`, staking `0x4A4B79957C758b82EdEa964c48Cb3b19286a3167`, and wrapped NAVE `0x7860FF876b49a5A992a7F3a4a6043ea57f17eD96`. No lock, burn, or relay was sent. The deployer has about **0.087 ETH** on this chain. A DAO create, deposit, or constitution cannot run until a factory and protocol exist.

## Solana devnet (read-only)

`VITE_SOLANA_RPC_URL` is a devnet endpoint. Public devnet genesis matches devnet. Deployer `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn` has about **8.21 SOL**. `nave_core`, `nave_governance`, and `nave_execution` are executable.

The same program id as the closed mainnet bridge (`Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`) is still executable on devnet. It was not instructed. `test:devnet:solana:smoke` was not started: it does not check the $19 creation stake, and this pass stayed off that program.

## Signatures from this run

None.

## Addendum — Sepolia and Base Sepolia RPC env

Probed around **2026-10-01T12:14Z**. `EVM_SEPOLIA_RPC_URL`, `EVM_BASE_SEPOLIA_RPC_URL`, and the matching `VITE_EVM_*_RPC_URL` client vars were set in gitignored env only (`.env.local` and `signer-service/.env`). No URL is written here. No transaction was broadcast. Chain ids **1**, **8453**, and **4663** were not called. The closed Solana bridge was not instructed.

| Check | Result |
|---|---|
| `npm run verify:devnet-multichain` | pass. Sepolia answers chain id **11155111**; app factory code is 3,856 bytes. Base Sepolia answers **84532**; app factory code is 76 bytes. `dao_registry`: **1** row on 11155111, **0** on 84532. |
| `scripts/evm-testnet-dao-e2e.sh 84532` | pass as a checklist. No broadcast. Adapter zeros unchanged: `balancerAdapter`, `compoundV3Adapter`. |
| `scripts/evm-testnet-dao-e2e.sh 11155111` | pass as a checklist. This was skipped earlier because the previous Sepolia host did not resolve. No broadcast. Adapter zero: `balancerAdapter` only. Aave and Compound are set. |
| `run-evm-testnet-suite.mjs --chain-id 11155111` (not `--live`) | exit 0. Fork preflight matched 11155111. `TestnetE2E` skipped because `EVM_TESTNET_LIVE` is off. No signature. Deployer balance about **0.5794 ETH**. The suite factory is the deployments-file address `0x4C8dBdEaa7f5B043dB9A8831023b67994Dc2cb36`, not the app factory. |
| `run-evm-testnet-suite.mjs --chain-id 84532 --live` | not run. The runner still refuses Base Sepolia live mode because Foundry cannot fork OP Isthmus blocks. |

On the app Base Sepolia protocol `0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02`: `daoCount` is **1**, `requiredNaveStake` is **0**, and `naveStakeToken` and `daoStake` are **0x0**. On the app Sepolia protocol `0x678e69c53E53904ca6D060040E14DFc56003BC11`: `daoCount` is **1**, and `requiredNaveStake` / `naveStakeToken` / `daoStake` revert. `GET /functions/v1/nave-price-oracle` is still **503** (`0 healthy NAVE market sample(s)`). Robinhood testnet still has no `VITE_EVM_ROBINHOOD_TESTNET_FACTORY_ADDRESS` or protocol address; `evm-launch-46630.json` is still bridge-and-stake only (`naveStake: null`). The existing signer RPC for that chain still answers **46630**.

The new RPCs let the multichain verifier finish and let the Sepolia checklist and non-live fork suite run. They do not supply a Base Sepolia stake module, a Sepolia stake view, an oracle quote, a Base Sepolia `dao_registry` row, or a Robinhood testnet factory.

## Signatures from this addendum

None.
