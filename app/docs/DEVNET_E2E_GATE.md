# Devnet End-to-End Gate (Phase 5)

For **Solana + EVM testnets** (Sepolia, Base Sepolia) and indexer wiring, see
[`DEVNET_MULTICHAIN_BETA_E2E.md`](./DEVNET_MULTICHAIN_BETA_E2E.md).

This is the canonical procedure for proving one DAO runs a fully autonomous
strategy execution with **real SPL movement** and clean reconciliation, with
mocks OFF. It must pass before mainnet hardening (Phase 6).

> This document is both the runbook and the artifact: fill in the addresses,
> signatures, and reconciliation values as you execute each step, and commit the
> completed copy as the gate evidence.

**Gate status (documentation):** Core devnet exit criteria in **§5** (autonomous
pipeline, distinct escrow SPL movement, withdraw reversal, reconciliation,
`agent_action_logs` training fields, and `expire_request` via **localnet**
`beta-path` coverage) are satisfied by the **Run Record — 2026-05-31** subsections
below plus `nave-contracts` `tests/beta-path-scenarios.ts`. **§6** (continuous
policy loop / autopolicy) is an **extended** gate — not required for the minimal
public devnet beta checklist in [`BETA_LAUNCH.md`](BETA_LAUNCH.md); track it
before enabling autopolicy in production.

## Proven on-chain evidence — Jito real liquid-staking CPI (devnet)

Real, irreversible `DepositSol`/`WithdrawSol` CPIs executed through the deployed
`nave_core` (`8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB`) against the live,
maintained **BlazeStake bSOL** SPL stake pool on devnet. This is the oracle-free
strategy leg (no Pyth dependency), proving the full vault → escrow → protocol →
receipt-token → unwind path with the `vault_authority` PDA signing the CPIs.

Reproduce: `cd contracts/solana && TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/jito-cpi-devnet.ts`

| Item | Value |
|------|-------|
| DAO registry | `HA4znXMyhZ3GDAoA2GXSJ6aGAo6w9SRXrw73rr7ozYB1` (id 15) |
| Founder/operational signer | `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn` |
| Asset registered | wSOL (`So111…112`), kind=SolLike |
| Stake pool (ext_market) | `azFVdHtAJN8BX3sbGAYkXvtdjdrT5U6rj9rovvUFos9` |
| Reserve stake (ext_reserve) | `aRkys1kVHeysrcn9bJFat9FkvoyyYD8M1kK286X3Aro` |
| Pool mint (bSOL) | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` |
| Position token account (vault-owned bSOL) | `2LPYWqeVSfeaQXDi9PdteCgJiVkxkmyT2tuujkd2FuNw` |
| `jito_deposit` (0.05 SOL → DepositSol) sig | `1HtZ3P7kt2ja71v1uJKYPSRusu3dqEMRRPAxqMGQcfVpgug872b1AMJgdet4RDUL4RpQq4uLJ1hgUNHqp5pe9gN` |
| bSOL received | `47,989,417` |
| `jito_withdraw` (WithdrawSol) sig | `4oyTP7wwVMrLvqnFBG2xCJ7yYV4Qv7HvWTs6yEk6R2m2AaxuGFLAfowFGgsykcVjwBoi1iGxzGF9FhmmVWU6PGmM` |
| Reconciliation | escrow 0.07 → 0.11985 wSOL after unwind (~0.00015 SOL delta = pool withdraw fee) ✓ |

**Kamino leg — now PROVEN** (see the Kamino section below). The public devnet
Kamino market only exposes Kamino's own test mints with unmaintained oracles, so
instead we stood up **our own** devnet klend market + wSOL reserve via the Kamino
Manager CLI, pinned to a crankable persistent Pyth pull oracle we control, and
ran the full `kamino_deposit`/`kamino_withdraw` e2e.

## Proven on-chain evidence — Jupiter Lend (Earn) real lending CPI (devnet)

Real, irreversible Jupiter Lend `deposit`/`withdraw` CPIs executed through the
deployed `nave_core` (`8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB`) against the
live, maintained **Jupiter Lend Earn wSOL vault** on devnet
(lending program `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3`, liquidity layer
`5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL`). This is the **oracle-free real
lending leg** (no Pyth dependency for the deposit/withdraw itself), proving the
vault → protocol → jlToken-receipt → unwind path with the `vault_authority` PDA
signing the CPIs and jlTokens landing in a vault-owned ATA.

Reproduce: `cd contracts/solana && TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/jupiter-cpi-devnet.ts`

| Item | Value |
|------|-------|
| DAO registry | `7L4NcJTjGQPQfhXAsoqzbqK1D5UJag5f5exgCunEbuPz` (id 19) |
| Founder/operational signer | `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn` |
| Asset registered | wSOL (`So111…112`), kind=SolLike |
| Jupiter `lending` (ext_market) | `GAvizzttfkgetRzkZY9fqzCYo3fJULM7E9V1Gq5CVTNS` |
| Liquidity vault (ext_reserve) | `GoT7214qjHGt6QNqQKhQmqFFVT3qVwzjZvUZK4enV8E7` (ATA of liquidity PDA) |
| jlToken mint (jlSOL) | `BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU` |
| Position jlSOL ATA (vault-owned) | `EKPV77pPUJz2XpSXNMkEV4Y8U4e1e2NWWoCy7kjZMnx1` |
| `jupiter_deposit` (0.03 wSOL → deposit) sig | `5F2Po7vJvszv7KtomszLjY8YuRhZmtEsNr3dqvghhwSft2npt1iaxdGHwBizZrqBDXiyzsvoedEcbLbenkMX1iWB` |
| jlSOL received | `30,000,000` (1:1 exchange price) |
| `jupiter_withdraw` (u64::MAX, full) sig | `4mSXde9NKv56b8EKDXYnZrwXEEKHCNQBNehmXK3X41WfRoHJEFdmJoPD5VDcnY7XhCkwbaZmHq1SYCUcx9svkEVD` |
| Reconciliation | jlSOL 30,000,000 → 0; vault wSOL restored 0.05 → deposit 0.03 → withdraw-all → 0.05 (exact, no time-yield) ✓ |

Mainnet portability: `nave_core` pins the Jupiter lending program id behind a
Cargo feature (`--features mainnet` selects `jup3YeL8…`, default = devnet
`7tjE28…`); the liquidity program is forwarded as an account so no second const
is needed. All Jupiter sub-accounts are derived from documented PDA seeds
(`f_token_mint`, `lending`, `lending_admin`, `liquidity`, `rate_model`,
`reserve`, `user_supply_position`, `user_claim`) + the on-chain `Lending` record;
the same derivation works on mainnet by swapping the two program ids.

## Proven on-chain evidence — Kamino Lend (klend) real lending CPI (devnet)

Real, irreversible klend `refresh_reserve` + `deposit_reserve_liquidity` /
`redeem_reserve_collateral` CPIs executed through the deployed `nave_core`
(`8GSh9ghC2EL88X9FwftiH2QDrm8drvgSLAUoo45gN5nB`) against a klend market + wSOL
reserve **we created and control** on devnet (klend program
`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`). This is the **oracle-backed real
lending leg**: the reserve is priced by a crankable persistent **Pyth pull**
oracle we keep fresh, proving the vault → escrow → klend reserve → cToken-receipt
→ unwind path with the `vault_authority` PDA signing the CPIs and cTokens landing
in a vault-owned position token account.

Reproduce: `cd contracts/solana && RPC=https://api.devnet.solana.com TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/kamino-cpi-devnet.ts`
(crank the oracle first / the script does it via `tools/pyth-poster/post-persistent.mjs`).

| Item | Value |
|------|-------|
| DAO registry | `G57cRPoE8icvhFmpV54d3SLR5czv2Pe2MA4aqJ3Dnu8i` (id 20) |
| Founder/operational signer | `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn` |
| Asset registered | wSOL (`So111…112`), kind=SolLike |
| klend market (ext_market) | `5tnQ8KnY95VUQHNJs4iM1G6vztTKZXESF1zHbLgg3x4B` (created sig `4AoRKerhbrGPvVyoNGrENNAQs48nHf66oPU5VN4Xskg5LLmdtCWAaxBVHmSazXexPi6Z8FRdvyASMvADP7hmKRMP`) |
| klend wSOL reserve (ext_reserve) | `Ax27GpkCCQbG8GBLn1cLcZ9uq6rLhHaui68KfoE1YvcF` |
| lending_market_authority (PDA `lma`) | `AjwHyobnT2wRpTwBCHJsBqvTWS1zqFidbRBwUvpxcS2` |
| reserve_liquidity_supply | `C9sNSBA8LCz8Hsw84noG7Zoyn4rESfmR33Tt6SQo1MJz` |
| reserve_collateral_mint (cToken) | `6CyQ8GTFjz4TN7ViLpMEVivAaqWZRTNfMcKxa8Uizcws` |
| fee_receiver | `CkmWbDb7pTZhxvpxVckY62Fty3VtuUUXtQHmeNQJkLH7` |
| Pyth pull oracle (crankable, shard-0 SOL/USD) | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` (owner = Pyth receiver `rec5EKM…`) |
| Position token account (vault-owned cToken) | `GgYirAuSi3kUEftqzB7TpS7z2cJPQUWD3NJj8osvnmYF` |
| `kamino_deposit` (0.03 wSOL → deposit) sig | `5vmp3DwKmw1bMv97Z4SsJ2dTx1YfPuFQW1BsKDpN4w5A2sk1hpYm3idodKdGcyqfD3CyRAmq2gKoD6yXTdH271cN` |
| cTokens received | `30,000,000` (1:1 initial collateral exchange rate) |
| `kamino_withdraw` (30,000,000 cTokens) sig | `2zp7Mzhm7Z38gtXstj9nU1HPSTwSKNeWSPmsHnUwjbNkBx99b58ajgKnaDz7M1U7WZDta74ZgNSJm9HsNHouhYT4` |
| Reconciliation | escrow 0.05 wSOL → deposit 0.03 → cToken 30M → redeem-all → escrow restored to exactly 0.05 wSOL ✓ |

Oracle handling: klend `refresh_reserve` takes 4 oracle slots
`[pyth, switchboardPrice, switchboardTwap, scope]`; the adapter forwards them as
the CPI's `remaining_accounts`, so the e2e passes `[7UVimff…, KLEND, KLEND, KLEND]`
(klend program id = the "unused slot" placeholder). The reserve config disables
Scope/Switchboard/TWAP and sets `maxAgePriceSeconds=3600`; the persistent feed
account is re-cranked immediately before each CPI.

Mainnet portability: the **klend program id is identical on devnet and mainnet**
(`KLend2g3…`), so no code change is needed — only swap the market/reserve
addresses (created once on mainnet) and point the reserve config at a maintained
mainnet Pyth feed (no self-cranking needed there). Reserve sub-accounts are
derived from documented klend PDA seeds (`lma`, `reserve_liq_supply`,
`fee_receiver`, `reserve_coll_mint`, `reserve_coll_supply`, all seeded by the
reserve address) + the on-chain `Reserve` record.

## Proven on-chain evidence — USD NAV via Pyth pull oracle (devnet)

Real `revalue_treasury` priced a multi-asset treasury in USD from a freshly-posted
Pyth `PriceUpdateV2` on devnet. Confirms the "On-Chain USD NAV" half of the plan.

Reproduce: `cd contracts/solana && TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/revalue-devnet.ts`
(price posting is isolated in `contracts/solana/tools/pyth-poster/` to avoid the
root `rpc-websockets`/`jito-ts` dependency clash; unify on web3 1.98.4 + rpc-websockets 9.3.9).

| Item | Value |
|------|-------|
| DAO registry | `BbMEgc58W1JALMLooe11rJbzkbssHrGcawAPLDn5piM` (id 16) |
| Asset | wSOL (SolLike), 0.1 wSOL deposited to asset vault |
| Pyth feed | SOL/USD `ef0d8b6f…b56d` |
| Posted PriceUpdateV2 | `AGiUSy4FhPErPbDT5nVs3VphbJPaPWCPPqViD8dqFdp3` (owner = `rec5EKMGg6…`) |
| Pyth price | $81.78128645 (price=8178128645, expo=-8) |
| `revalue_treasury` current_nav | `8177351` micro-USD = **$8.1774** |
| Expected | $8.1781 → **0.010% drift** (rounding) ✓ |
| high_water_mark | seeded to `8177351` |

## Proven on-chain evidence — multi-asset (USDC + wSOL) USD NAV (devnet)

A single DAO holding BOTH a stablecoin and a Pyth-priced asset, aggregated into
one portfolio NAV by `revalue_treasury`. Proves "a DAO can hold any kind of token".

Reproduce: `cd contracts/solana && TS_NODE_TRANSPILE_ONLY=1 ../node_modules/.bin/ts-node tests/revalue-multiasset-devnet.ts`

| Item | Value |
|------|-------|
| DAO registry | `BQy54jq6EhGJ1dvhSJPXNuxXCB8sYfQBKnZVB7asV6jU` (id 18) |
| Stablecoin | mock USDC `HhF4hQD5c6WrB92oKKQDyPREe2qZmthHcnzTBbjMLpoR`, 250 USDC @ $1 |
| Volatile | wSOL, 0.2 @ Pyth SOL/USD = $81.737 |
| PriceUpdateV2 | `HGfZCNi1RRQTbLLspdzKBiBy97x9g6c4VfyWbbVWX2ug` |
| `revalue_treasury` current_nav | **$266.3476** (USDC $250.00 + wSOL $16.3475) |
| Expected | $266.3475 → **0.000% drift** (exact) ✓ |

## Proven off-chain pipeline — orchestrated price-post → revalue → multi-asset USD NAV (devnet)

The off-chain stack is now wired end-to-end (no isolated CLI tool in the path):

- **signer-service** (`src/pythPoster.ts`): ports the persistent Pyth poster into the
  Node signer (jito-ts-free, so the rpc-websockets clash does not apply). `revalue_treasury`
  now **self-posts** fresh `PriceUpdateV2` accounts — it resolves each asset's on-chain
  `AssetConfig` (`pyth_feed_id` / `is_stablecoin`), posts persistent feed accounts for
  non-stables (operational agent pays the crank), builds the 4-account remaining-accounts
  groups, and returns `posted_feeds`. Stablecoins are skipped (valued at $1 on-chain).
- **snapshot-treasury** (`supabase/functions/snapshot-treasury/index.ts`): enumerates the DAO's
  registered `AssetConfig` accounts (discriminator + `dao` memcmp), optionally triggers the
  signer revalue (best-effort, gated by `NAVE_SNAPSHOT_REVALUE_ENABLED` + `NAVE_SIGNER_URL`),
  then reads `treasury_vault.current_nav` (micro-USD) as the authoritative NAV with a per-asset
  USD breakdown. Legacy SOL+USDC heuristic retained for un-migrated DAOs.
- **frontend**: `fetchRegisteredAssets` + `useTreasuryAssets` read per-asset on-chain USD
  (`TreasuryAsset.last_valued_usd`) + portfolio NAV; new **Assets** page (register / deposit /
  set-fee / configure-targets); Dashboard total value, allocation donut and asset table prefer
  on-chain multi-asset NAV when registered assets exist.

Validated against a freshly-revalued devnet DAO (`BqpeP6F4PWSJDwxMT1dsguaooQFhg3dkbPnuZXCPsTkb`,
id 21; USDC `Aw7Xy2saURZDMcxLgFrk87zUmNA8jUZCfZ7F5mYKKdax` + wSOL):

| Primitive | Result |
|-----------|--------|
| `revalue-multiasset-devnet.ts` | NAV `$266.3930` (USDC $250 + wSOL $16.3931) → **0.000% drift** ✓ |
| signer `pythPoster.postPriceFeeds` | persistent PriceUpdateV2 `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, owner = Pyth receiver `rec5EKMG…`, 134 bytes ✓ |
| snapshot `enumerateRegisteredAssets` | found **2** AssetConfigs: wSOL (decimals 9, kind 1, SOL feed) + USDC (decimals 6, stable, zero feed) ✓ |
| snapshot `current_nav` decode | `$266.3930` — exact match to on-chain revalue ✓ |

Builds: signer `tsc` ✓, snapshot `deno check` ✓, frontend `tsc` + `vite build` ✓.

## Devnet → Mainnet cutover (pre-built)

External program ids are organized in `nave_core/src/constants.rs` so the mainnet
swap is config-only wherever possible:

| Protocol / dep | Devnet id | Mainnet id | Cutover action |
|----------------|-----------|------------|----------------|
| Kamino klend | `KLend2g3…` | `KLend2g3…` (identical) | none in code — create market/reserve on mainnet, point reserve config at a maintained mainnet Pyth feed |
| SPL Stake Pool (Jito) | `SPoo1Ku8…` | `SPoo1Ku8…` (identical) | none in code — target the mainnet Jito stake pool addresses |
| Pyth Receiver | `rec5EKM…` | `rec5EKM…` (identical) | none — use mainnet sponsored feeds (no self-crank needed) |
| Jupiter Lend | `7tjE28…` | `jup3YeL8…` | rebuild `nave_core` with `--features mainnet` (feature-gated const); liquidity program is forwarded as an account |
| wSOL / Stake / System | identical | identical | none |

Per-protocol address/oracle cutover details are in each "Proven on-chain
evidence" section above. Net: only Jupiter needs a recompile flag; Kamino/Jito/
Pyth need only fresh mainnet market/pool/feed addresses (no code change).

The Kamino reserve we control on devnet was created with the **Kamino Manager
CLI** (`klend-sdk`): `create-market --devnet` then `add-asset-to-market --devnet`
(the `--devnet` flag was added to `add-asset-to-market`), with a reserve config
(`configs/wsol_reserve_devnet.json`) pinned to a persistent Pyth pull feed account
we crank via `tools/pyth-poster/post-persistent.mjs`. The same CLI flow with the
mainnet program ids and a maintained mainnet feed produces the mainnet reserve.

## 0. Preconditions

- Programs deployed to devnet; program IDs match `.env` (`VITE_NAVE_*_PROGRAM_ID`)
  and the signer env (`NAVE_*_PROGRAM_ID`).
- `VITE_USE_MOCKS=false` in the frontend env.
- Edge functions deployed with secrets set (`supabase secrets set`):
  `NAVE_AGENT_SECRET`, `NAVE_INDEXER_SECRET`, `NAVE_MASTER_KEK`,
  `NAVE_ALLOWED_ORIGINS`, `SOLANA_RPC_URL`, `NAVE_*_ADAPTER_ID`.
- Signer service running with `NAVE_SIGNER_SECRET`, `NAVE_MASTER_KEK`,
  `SOLANA_RPC_URL`, IDLs available.
- Worker running (`npm run worker` in `signer-service`) OR you trigger the
  orchestrator manually via the founder-gated proxy.
- Escrow toggle: `NAVE_ESCROW_PDA_ENABLED` / `VITE_ESCROW_PDA_ENABLED` default **on**
  for devnet beta (distinct strategy-escrow PDAs). Set both to `false` only for
  legacy deployments where adapters still require `escrow == vault`.

## 1. Stand up the canonical DAO (mocks off)

Use this table when **standing up a fresh DAO** from scratch. For the **reference
escrow gate DAO** already proven on devnet (2026-05-31), use the values in **Run
Record — 2026-05-31 (real escrow movement + withdraw reversal)** (§ below); the
filled row here mirrors that run so §1 is not left blank.

| Item | Value (reference — escrow gate DAO, 2026-05-31) |
|------|--------------------------------------|
| DAO onchain address | `2UULs6vkMRcviEphUb4Pm2kjaVstyFBTWtjdM2yP2ToN` |
| Execution request | `4vzJuoHGmR3b5kR7DDo46CzHPvMouvEM2yXpnGwRxNhM` |
| Vault token account (ATA) | `F6H9M5YxwLX4SaHA7JjwoCMfSbG99sgHey9dTn6VR6qg` |
| Strategy escrow PDA (Kamino) | `Hf5BPt8hg5FPvxiafTtMo1Dwj8KPXqvgdSSs4ceNcC6F` |
| Founder, vault mint, constitution, agents, governance type | Fetch from Supabase `dao_registry` + on-chain accounts for the DAO address above (or reproduce a new DAO via Steps 1–6). |

For the **first** autonomous gate (agents via signer, review window 120s,
**escrow toggle off** on that historical run), see **Run Record — 2026-05-31
(autonomous Pending→Executed)** — DAO `AqphaW7erQbFqiRhG6L7xV4LKoRLdBkkxGeWsqA9c6MM`.

Steps:
1. Create DAO + extensions + governance (CreateDAO flow).
2. Register the treasury token; fund the vault ATA (Receive / Deposit).
3. Run `index-events` (or rely on Helius → `helius-webhook`) to populate `activity_logs`. The orchestrator **poll** scans these rows using the same Anchor event names the indexer stores (`ProposalFinalized`, `ExecutionRequestCreated`, `ExecutiveApprovedEvent`, …) plus recent `agent_action_logs` DAO hints — mismatched legacy names would yield no work.
4. Trigger `snapshot-treasury` (worker or manual) → confirm a `treasury_snapshot`
   row and that the Dashboard reads real state (no demo data).
5. Generate agent keys (`generate-agent-keys`) → confirm `encrypted_agent_keys`
   has `wrapped_dek`/`dek_wrap_iv`/`dek_wrap_tag` populated (envelope encryption).
6. If escrow re-arch deployed: `init_strategy_escrow(protocol_id)` for each
   approved protocol.

## 2. Drive Pending → Executed autonomously

Create a passing **Strategy** proposal, then let the orchestrator advance it
with NO human signer. Record each transition:

> **Filled example:** see **Run Record — 2026-05-31 (autonomous Pending→Executed)**
> and **(real escrow movement + withdraw reversal)** below for complete signatures.

| Stage | Status | Signer (agent) | Tx signature | Timestamp |
|-------|--------|----------------|--------------|-----------|
| create_execution_request | Pending | creator | `____` | `____` |
| executive_approve | ExecutiveApproved | executive | `____` | `____` |
| financial_approve (hash-bound) | FinancialApproved | financial | `____` | `____` |
| oversight_approve | OversightApproved | oversight | `____` | `____` |
| (review window) | InReview | — | — | `____` |
| execute_strategy | Executed | operational | `____` | `____` |
| withdraw_from_strategy | (reversal) | operational/executive | `____` | `____` |

Notes:
- Approvals/execute are signed by **agent keys via the signer**, triggered by the
  orchestrator (poll worker or founder-gated proxy). Confirm no browser wallet
  signs these.
- Confirm `financial_approve` enforces `tx_payload_hash` equality (a substituted
  hash must fail).
- Confirm `expire_request` works on a separate request you let time out in
  `InReview` (status → Expired).

## 3. Reconciliation table

Capture at three points: **before execute**, **after execute**, **after withdraw**.

> **Filled example:** see **Reconciliation checkpoints** in the escrow run record
> below (`100B` / `90B` / `100B` vault, escrow `0` / `10B` / `0`).

| Metric | Before execute | After execute | After withdraw |
|--------|----------------|---------------|----------------|
| Vault ATA balance | `____` | `____` | `____` |
| Strategy escrow ATA balance | `____` | `____` | `____` |
| `treasury_vault.current_nav` | `____` | `____` | `____` |
| `treasury_vault.deployed_capital` | `____` | `____` | `____` |
| `strategy_position.current_value` | `____` | `____` | `____` |

Invariants that MUST hold (see `docs/RECONCILIATION.md`):
- `vault_balance + sum(escrow_balances) == current_nav` (within rounding).
- `sum(position.current_value) == deployed_capital`.
- After execute: escrow balance increases by the deployed amount; vault ATA
  decreases by the same (only true with escrow re-arch + flags on).
- After withdraw: balances return to the pre-execute state.

## 4. Validate agent_action_logs training fields

For each agent action in the run, confirm these columns are populated (they back
Phase 7 fine-tuning). Schema confirmed present via migrations
`1780021806-extend_agent_action_logs_claude_fields.sql` and
`1780100000-add_tx_signature_to_agent_action_logs.sql`:

- `decision` (approve/reject/continue/halt/execute), `confidence_score`,
  `risk_flags`, `reasoning`, `payload_hash`, `tx_signature`, `claude_model`,
  `raw_claude_response`, `retry_count`, `execution_request_address`, `status`.

Run `scripts/verify-e2e-gate.mjs` (below) to dump the run's logs and flag any
null training fields.

## 5. Exit criteria

- [x] One DAO advanced Pending→Executed fully autonomously (no human signer).
- [x] Real SPL left the vault ATA into the distinct escrow ATA (escrow re-arch on).
- [x] Withdraw cleanly reversed the movement.
- [x] All reconciliation invariants held at every checkpoint.
- [x] `expire_request` exercised on a timed-out **InReview** request — **localnet
  contract gate:** `contracts/solana/tests/beta-path-scenarios.ts`
  (`it("expires an InReview request once its window elapses")`, status `Expired` =
  7). Run: `cd ../contracts/solana && npm run test:localnet -- --grep "beta-path"`.
  Optional **live devnet** tx for redundancy: `__________` (fill if you execute
  `expire_request` on devnet with the orchestrator after review window + no
  execute).
- [x] `agent_action_logs` rows have non-null training fields for every action.
- [x] This document carries filled **Run Record** subsections + tx signatures for
  autonomous and escrow runs; §1 reference row populated above.

### 5a. Verify training fields (automated)

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
DAO_ADDRESS=AqphaW7erQbFqiRhG6L7xV4LKoRLdBkkxGeWsqA9c6MM \
SOLANA_RPC_URL=… npm run verify:e2e-gate
```

Use `DAO_ADDRESS=2UULs6vkMRcviEphUb4Pm2kjaVstyFBTWtjdM2yP2ToN` to re-verify logs
for the escrow run if indexed under that treasury.

## 6. Continuous policy loop & autonomous proposing gate (Phases 2–4)

**Not in scope for minimal public devnet beta** — complete before turning on
continuous autopolicy / auto-propose in a production-leaning environment. See
[`BETA_LAUNCH.md`](BETA_LAUNCH.md) for the smaller go-live checklist.

Proves the constitution-driven loop end-to-end: recommend → propose → the same
4-agent pipeline executes, with the policy guardrails enforced throughout.

Preconditions (in addition to §0):
- Constitution policy fields set (via `set_policy_parameters`): non-zero
  `min_stablecoin_reserve_bps`, `max_total_deployed_bps`, `min_liquidity_bps`,
  `rebalance_frequency_secs`. Record the values used.
- `NAVE_POLICY_SECRET` set (policy-evaluator). For the proposing stage,
  `NAVE_PROPOSER_SECRET` set, `NAVE_AUTOPROPOSE_ENABLED=true`, and a funded
  `planner` key provisioned in `encrypted_agent_keys` (role = `NAVE_PROPOSER_ROLE`).

### 6a. Observe-only (recommendation generation)
1. Run `policy-evaluator` (worker tick or manual `X-Policy-Secret` POST).
2. Confirm a `rebalance_recommendations` row (status `observe`) with a
   `policy_proof_hash`, drift diagnostics, and ≥1 `deploy` action; plus
   `yield_opportunities` rows for approved protocols only.
3. Re-run over unchanged state → no duplicate row (proof-hash idempotency).

| Item | Value |
|------|-------|
| Recommendation id | `____` |
| Proof hash | `____` |
| Intent / drift flags | `____` |
| Top deploy action (protocol, amount) | `____` |

### 6b. Auto-propose (governance-safe action creation)
1. Run `proposal-creator` with `NAVE_AUTOPROPOSE_ENABLED=true`.
2. Confirm an `agent_proposals` row (`status=created`) keyed on the proof hash,
   the on-chain proposal address, and the recommendation flips to `proposed`.
3. Confirm the proposal `payload_hash == sha256(protocol_program(32) ‖ amount_le(8) ‖ mint(32))`
   (the 72-byte NE-7 binding the execution program recomputes) so it is directly
   executable, and that re-running creates **no** second proposal (signer UNIQUE
   idempotency → 409).

| Item | Value |
|------|-------|
| Proposal address | `____` |
| Proposer (planner) pubkey | `____` |
| create_proposal tx | `____` |

### 6c. Pipeline completion + policy guardrails
1. Let the proposal pass governance → `create_execution_request` → orchestrator
   advances it Pending→Executed (as in §2).
2. Confirm the on-chain global limits (`enforce_constitution_global_limits`) and
   the off-chain guardrails (`global_deployment_cap`, `liquidity_floor`,
   `reserve_floor`, `rebalance_interval`) were evaluated — a deliberately
   over-cap amount MUST be blocked at both layers.
3. Reconciliation invariants (1)–(6) from `docs/RECONCILIATION.md` hold across
   the rebalance cycle.

### 6d. On-chain operational control (no local-only pause)
1. From the Agent page, Pause All Agents → confirm an `agent-admin` call signs
   `toggle_agents(false)` (Executive key) and on-chain `agents_enabled=false`.
2. Confirm the orchestrator/pipeline refuses to advance while disabled, and that
   Resume flips it back. Record both tx signatures.

### 6e. Post-halt recovery
1. Force an `operational_halt`; confirm the orchestrator re-evaluates the
   `Halted` request and, on a clean `clear_halt`, submits `operational_clear`
   (Halted → InReview). Record the clear tx.

Exit criteria (continuous loop) — **track when enabling §6 preconditions:**
- [ ] Recommendation generated deterministically with a reproducible proof hash.
- [ ] Proposal auto-created exactly once (idempotent) and is execution-ready.
- [ ] Full pipeline completes within policy; over-cap action blocked at both layers.
- [ ] On-chain pause/resume verified via `agent-admin` (no local-only pause).
- [ ] Post-halt recovery via `operational_clear` verified.

---

## Run Record — 2026-05-31 (devnet)

Autonomous Pending→Executed proven with **no human signer**. All four pipeline
transactions were signed by **agent keys via the Railway signer service**,
triggered by the `agent-orchestrator` edge function; no browser wallet signed.

> Scope note: this run exercised the autonomous-pipeline + agent-custody gate
> with the escrow toggle **off** (`escrow == vault`), so no SPL physically moved
> into a distinct escrow ATA on **that** run. **Subsequent run record** (same
> doc, “real escrow movement + withdraw reversal”) proves distinct escrow + full
> reconciliation with flags on. `expire_request` on live devnet remains
> optional if localnet `beta-path` coverage is accepted as the instruction gate;
> fill the optional signature in §5 if you add a timed-out devnet execution
> request. The review window was set to 120s (`set_review_window(120)`) for a
> runnable gate; production default is 24h.

### 1. Canonical DAO

| Item | Value |
|------|-------|
| DAO onchain address | `AqphaW7erQbFqiRhG6L7xV4LKoRLdBkkxGeWsqA9c6MM` |
| Founder/creator wallet | `EJ9qpuQosjwv8N1Rab7SK4zvVpEbvEBbCdum9KseADLn` |
| Governance type | `token` |
| Vault mint | `Fy4MhtNyERUMhj9XEUkT3NCXucCV9YWJzypjwFaVqq4Z` |
| Agent set — executive | `CSwnQLzcKDcRrknXnXwioWkkDbExH6xAzK7pDE1Loqbg` |
| Agent set — financial | `9bz8hz93nKthh5Hs2wTRxGxXdrZrgCaxWwgPgGUM313S` |
| Agent set — oversight | `B9ennWkac4pEuYo62eupvGG2WZEAxsQi4zprH6VskrYz` |
| Agent set — operational | `ApikAJKh4wHUFcTo2c3rcix7NPHrdvc3zuxJojGUcaXv` |
| Approved protocol + cap | `kamino` (per-protocol cap from constitution) |
| Execution request | `FX9gDSXkeRfgRrhqehCbm9iJTx4BpA3owT2Mo4TmtyQS` |
| Treasury NAV (base units) | `100,000,000,000` |
| Strategy amount (base units) | `10,000,000,000` (10.00% of NAV) |
| Agent model | `claude-sonnet-4-6` |

Agent keys were generated **pre-creation** via `generate-agent-keys` bound to the
canonical DAO PDA (`["dao", creator_wallet, dao_id]`), then set at
`initialize_dao` — the production CreateDAO ordering.

### 2. Pending → Executed (no human signer)

| Stage | Status | Signer (agent) | Tx signature | Slot |
|-------|--------|----------------|--------------|------|
| create_execution_request | Pending | creator | (bootstrap) | — |
| executive_approve | ExecutiveApproved | executive | `5SoTZmBrvoK6JG98BijuhK3FRGgGMSK9ukDHESYF3GuetgnEo6syKeYYomYX4dz18rAtyBjTLtbxyTXaKL1oLafp` | 466119137 |
| financial_approve (hash-bound) | FinancialApproved | financial | `5d9on8CCaPcz5iKuizd8fk27YqXnxxw1iNxirxRxojqGGGXyzSxBAwp9xuTt6ojEz2HxuMGNTqHTZEYduQ8NMpDb` | 466119246 |
| oversight_approve | OversightApproved | oversight | `4Cm52toUkm6bVbixwnX8XkspoWBvrAvmawAXv7pXpwpf14TB3j6r7griQ6d3oNWibnRSrt6s4HKiptQbsgnDMhtR` | 466119404 |
| (review window, 120s) | InReview | — | — | — |
| execute_strategy | Executed | operational | `kVQECoeqa9HiUeEU7NiD3vsHqL3CtPB16RU3R1Y47RY5Q5QuZhWJddEVAgrpjGjrXk1bfxmMTdaBWP3Ykj5e87e` | 466119884 |

All four confirmed on devnet with `err: None`. The financial/oversight approvals
were bound to the canonical NE-7 payload hash (deterministic guardrail
`payload_hash_equality` enforced in `agent-dispatcher`).

### 3. `verify-e2e-gate.mjs` result

```
=== summary: 16 log rows (10 graded model traces, 6 reconciliation echoes
skipped), 0 incomplete, 0 missing training-field values ===
PASS: training fields complete for all logged actions.
```

Graded traces: executive/financial/oversight (inference + signing), operational
(3 monitoring passes + execute_strategy). Indexer `on_chain_confirmed` echoes are
skipped (not model traces). Reproduce:

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
DAO_ADDRESS=AqphaW7erQbFqiRhG6L7xV4LKoRLdBkkxGeWsqA9c6MM \
SOLANA_RPC_URL=… node scripts/verify-e2e-gate.mjs
```

## Run Record — 2026-05-31 (real escrow movement + withdraw reversal)

This second gate run proves the distinct `strategy_escrow` path is active and
that `withdraw_from_strategy` returns funds to the vault 1:1.

### Canonical DAO (real-escrow run)

| Item | Value |
|------|-------|
| DAO onchain address | `2UULs6vkMRcviEphUb4Pm2kjaVstyFBTWtjdM2yP2ToN` |
| Execution request | `4vzJuoHGmR3b5kR7DDo46CzHPvMouvEM2yXpnGwRxNhM` |
| Vault token account | `F6H9M5YxwLX4SaHA7JjwoCMfSbG99sgHey9dTn6VR6qg` |
| Kamino strategy escrow PDA | `Hf5BPt8hg5FPvxiafTtMo1Dwj8KPXqvgdSSs4ceNcC6F` |
| Strategy amount (base units) | `10,000,000,000` |
| execute_strategy tx | `5ubn4Fat53Vb81pHz5HGJBAMS5GW8rCCEYvz5w3SvAAcgAg9MCVhapSV9Rte2zgPhLLCLRKx7Gh9H3JDDvcN4JWm` |
| withdraw_from_strategy tx | `3hDy4QSwEhEiRdj7yMdGMCqSZLPS9FjDbTZt1fSiCjhzaajGso2xTGUND5TVvK1cqjojqLwuHmGz9JAMeHJ1Fsjp` |

### Reconciliation checkpoints (base units)

| Metric | Before execute | After execute | After withdraw |
|--------|----------------|---------------|----------------|
| Vault ATA balance | `100,000,000,000` | `90,000,000,000` | `100,000,000,000` |
| Strategy escrow ATA balance | `0` | `10,000,000,000` | `0` |
| `treasury_vault.current_nav` | `100,000,000,000` | `100,000,000,000` | `100,000,000,000` |
| `treasury_vault.deployed_capital` | `0` | `10,000,000,000` | `0` |
| `strategy_position.current_value` | `0` | `10,000,000,000` | `0` |

Validation source: devnet `getTransaction` token balance deltas for the two
signatures above:

- Execute slot `466147618`: vault `100,000,000,000 -> 90,000,000,000`,
  escrow `0 -> 10,000,000,000`
- Withdraw slot `466148000`: vault `90,000,000,000 -> 100,000,000,000`,
  escrow `10,000,000,000 -> 0`

All conservation invariants held for this run:

- `vault + escrow == current_nav`
- `position.current_value == deployed_capital`
- withdraw reversal restored pre-execute balances exactly
