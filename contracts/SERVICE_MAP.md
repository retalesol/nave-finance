# Nave Bridge + Stake — Service Map

Scope: the cross-chain NAVE ⇄ wNAVE bridge and the staking/rewards system across
Solana (`nave_bridge`, `nave_staking`), EVM (`WrappedNave`, `NaveBridge`,
`NaveStaking` on Sepolia 11155111 / Base Sepolia 84532), the signer-service
relayer/mirror/watcher, and the frontend Bridge/Stake surfaces. Traced against
the current code (2026-07-08). This is a **trusted single-relayer** bridge: the
on-chain programs move and bound all value; the off-chain relayer verifies source
transactions independently and drives the destination.

Repos:
- `nave-contracts/` — `solana/` (Solana), `evm/` (EVM).
- `nave-app/` — `src/` (frontend), `signer-service/` (backend relayer + worker).

---

## 1. Trust boundaries & value-movement points

| Boundary | Trusted party | What bounds it |
|----------|---------------|----------------|
| Solana `release` | `config.relayer` hot key | pause, per-tx cap, rolling daily cap, `ProcessedRelease` replay PDA |
| EVM `bridgeIn` (mint) | `NaveBridge.relayer` EOA | pause, per-tx cap, rolling daily cap, `processed[keccak(srcChainId,srcNonce)]` |
| EVM `WrappedNave.mint` | `minter` = `NaveBridge` lockbox (contract) | `mintPaused`, `supplyCap` |
| Admin setters (caps/pause/relayer/fees) | `owner` (Solana `BridgeConfig.owner` / EVM `owner`) | two-step ownership handoff |
| Solana program bytecode | program **upgrade authority** | (mainnet: → Squads) |
| `notifyReward` (EVM staking) | `rewarder` EOA | `onlyRewarder`, reverts on empty pool |
| Staking-mirror fund moves | relayer keypair (collector owner) | worker DB lease, on-chain caps |
| Public `POST /bridge-relay` | **untrusted** (browser) | on-chain source verification + recipient-from-event + `unique(source_tx)` + IP rate limits |

**Value-movement points:** Solana `lock` (pull gross → custody, resolve fee),
`release` (custody → recipient + fee), fee `distribute_fee` (burn/staking/protocol
out of custody); EVM `bridgeIn` (mint net wNAVE), `burn`/`bridgeBurn` (destroy
wNAVE); staking `stake`/`unstake`/`claim` (both chains); staking-mirror
`collector → reward_vault` (Solana) and `collector → custody → bridgeIn →
notifyReward` (EVM).

**Anti-theft core property (verified under test):** the payout recipient is
ALWAYS derived from the on-chain source event (`BridgeLock.evm_recipient` /
`BridgeBurnTo.solanaRecipient`), never from the HTTP body. A forged/replayed body
can only complete the victim's own transfer to the victim's own recipient.

---

## 2. Per-chain contracts, entry points & authorities

### Solana — `nave_bridge` (`Fu3ZpX1SMvqVhuo7E4uKGvJxe6cJDFDxxmSCET6de9u6`)
- **State:** `BridgeConfig` PDA `[b"bridge_config"]`; custody token account
  `[b"bridge_custody"]` owned by custody-authority PDA `[b"bridge_custody_authority"]`;
  `ProcessedRelease` PDA `[b"bridge_processed", config, source_chain_id LE, source_message_id]`.
- **Entry points:** `initialize_config` (upgrade-authority-gated, init-race guard),
  `set_config`, `set_relayer`, `set_paused`, `transfer_ownership`/`accept_ownership`
  (two-step, owner-only); `lock` (any user, embeds `evm_recipient`), `release`
  (relayer-only).
- **Authorities:** `owner` (admin), `relayer` (release), custody-authority PDA
  (signs custody moves), upgrade authority (bytecode).
- **Fee (on-chain):** `fee_bps=250` split `staking=100 / protocol=100 / burn=50`
  (`constants.rs`); math in `fees.rs` — protocol leg absorbs integer-division dust,
  so `staking+protocol+burn == fee` exactly.

### Solana — `nave_staking` (`AxVdBgc8eUZ3VXKCCJxF7mAmRAtvtM2eYAbE3XBjnhjf`)
- **State:** `StakePool` PDA `[b"stake_pool"]`; `stake_vault` / `reward_vault`
  owned by pool-authority PDA `[b"stake_pool_authority"]`; per-user `UserStake`
  PDA `[b"user_stake", owner]`.
- **Entry points:** `initialize_pool` (upgrade-authority-gated), `stake`,
  `unstake` (always available, even paused), `claim`, `sync` (permissionless
  drip poke), `set_paused`, `set_reward_duration`, `init_reward_schedule`
  (one-time), two-step ownership.
- **Model:** single flexible pool — MasterChef `acc_reward_per_share` (@1e12) +
  Synthetix rolling 365-day drip. **No tiers/locks; NOT coupled to `nave_core`
  DaoStakeLock.** `reward_vault` is the destination of the bridge's 1% staking leg.
- **Devnet PDAs:** config `B7AEEMHQ…KLY7`, custody `Cww4xtt…2AmF`, stakePool
  `ErPMXb4Z…Efxt`, rewardVault `ERC6Wdtv…CtCwCW`, stakingCollector `7HP36mTi…z1T`.

### EVM — `WrappedNave.sol` (Sepolia/Base Sepolia `0x8412…fc50`)
- ERC-20 + ERC20Permit, 6 decimals. `mint` (onlyMinter, `mintPaused`+`supplyCap`
  gated), `burn` / `bridgeBurn(amount, solanaRecipient)` (user exit), `burnFrom`
  (minter-gated, dead in lockbox deployment). Two-step `setMinter`/`acceptMinter`
  and `transferOwnership`/`acceptOwnership`. Early-stage freeze control with
  irreversible `renounceControl`.

### EVM — `NaveBridge.sol` lockbox (`0xdC2c…ACf0`)
- Sole `minter` of WrappedNave. `bridgeIn(recipient, netAmount, srcChainId,
  srcNonce)` (onlyRelayer; pause + perTxCap + dailyCap + replay map, CEI order:
  `processed[key]=true` before `wnave.mint`). `acceptMinterRole`, `setPaused`,
  `setRelayer`, `setCaps`, two-step ownership.

### EVM — `NaveStaking.sol` (`0x72939965…35b3`)
- `ReentrancyGuard`+`SafeERC20`. `stake`/`unstake`/`claim` (accumulator @1e12 +
  Synthetix drip), `notifyReward` (onlyRewarder, reverts on empty pool),
  `sweepDust` (owner, recovers rate-truncation dust after window), `pendingReward`
  view, `setRewardsDuration`/`setPaused`/`setRewarder`, two-step ownership.

### Authority posture (devnet, `deployments/devnet.json` `bridgeV2`)
- `owner == relayer == upgrade authority == EJ9qpuQ…ADLn` on Solana; EVM
  `owner == relayer == rewarder == 0x6695…E06D`. **This overlap is finding P1
  (see AUDIT_LOG.md) and must be split before mainnet.**

---

## 3. Backend (signer-service)

| Surface | File / symbol | Role |
|---------|---------------|------|
| `POST /bridge-relay` | `index.ts` → `handleBridgeRelay` | public, verifying relay entry (503 when `BRIDGE_RELAYER_ENABLED` off); IP-rate-limited; `retry:true` opts into bounded re-execution |
| `GET /bridge-queue` | `index.ts` → `getBridgeQueueCounts` | ops surface: pending/failed/stuck counts |
| `POST /staking-mirror/run` | `index.ts` → `runStakingMirror` | manual mirror trigger |
| relay orchestration | `bridgeRelayer.ts` `handleBridgeRelay` | verify source on-chain → idempotent `pending` insert (`unique(source_tx)`) → drive destination → mark `completed`/`failed` |
| source verification | `bridgeRelayer.ts` `verifySolanaLock` / `verifyEvmBurn` | finalized Solana / ≥5-conf EVM; recipient from event |
| destination exec | `bridgeRelayer.ts` `mintWrappedOnEvm` / `releaseNaveOnSolana` | lockbox `bridgeIn` / program `release` |
| fee-drift guard | `bridgeRelayer.ts` `checkBridgeFeeBpsDrift` (+ `bridgePrograms.decodeBridgeConfigFees`) | startup: on-chain `fee_bps` vs env `BRIDGE_FEE_BPS` (non-fatal, logs) |
| staking mirror | `stakingMirror.ts` `runStakingMirror` | split collector by live stake weight → Solana `reward_vault`+`sync`; EVM `custody→bridgeIn→approve→notifyReward` (srcChainId 901); audit rows in `bridge_stake_events` |
| bridge watcher | `bridgeWatcher.ts` `runBridgeWatcher` | `retrySweep` (re-drive stale `pending`/`failed`, park `stuck`) + `missedEventScan` (BridgeLock/BridgeBurnTo with no row) |
| worker | `worker.ts` | intervals + cross-replica DB leases (`safeLeased`) around all money-moving loops |
| on-chain codecs | `bridgePrograms.ts` | `release` ix encode, `BridgeLock` decode, `ProcessedRelease` PDA derive (incl. `source_chain_id` LE), lockbox/wNAVE ABIs |

Config env is `BRIDGE_*` / `STAKING_MIRROR_*` (see `readBridgeConfig` /
`readStakingMirrorConfig`). **Keys are raw env secrets today (KMS/HSM gap).**
Supabase tables: `bridge_transfers` (`unique(source_tx)`, `status`,
`retry_count`), `bridge_stake_events` (`reward_topup`/`stake`/`unstake`,
`unique(source_tx)`), `worker_locks` (leases).

---

## 4. Frontend

| Surface | File | Calls |
|---------|------|-------|
| Bridge page/form | `src/pages/BridgePage.tsx`, `src/pages/Bridge.tsx` | render + submit |
| Bridge hook | `src/hooks/useBridge.tsx` | user signs `lock`/`bridgeBurn` on source chain, then `POST /bridge-relay`; polls status; "Retry relay" → `retry:true` |
| Stake widget | `src/components/StakeBox.tsx`, `src/hooks/useStaking.tsx` | Solana stake/unstake/claim; EVM approve→stake, claim |
| Stats | `src/hooks/useBridgeStats.ts` | APY / fee-split display (per-chain vs global-weight note) |
| Program clients | `src/lib/bridge/solanaBridgeProgram.ts`, `src/lib/staking/solanaStakingProgram.ts`, `src/lib/staking/naveStakingAbi.ts` | PDA derivation / ABIs (mirror backend) |

Client values are never trusted for payout — the recipient is embedded in the
signed source tx.

---

## 5. Lifecycle: one bridge transfer

**Solana → EVM (lock → mint):**
1. User calls `nave_bridge.lock(net, dest_chain_id, evm_recipient)` — one
   signature; pulls `gross = net + fee` into custody, resolves fee on Solana
   (burn/staking/protocol), emits `BridgeLock{evm_recipient, net, nonce}`.
2. Frontend `POST /bridge-relay {direction:solana_to_evm, sourceTx}`.
3. `handleBridgeRelay` → `verifySolanaLock` (finalized) → recipient/amounts from
   event → idempotent `pending` row → `mintWrappedOnEvm` → lockbox `bridgeIn`
   mints `net` wNAVE (replay key `(900, nonce)`) → row `completed`.

**EVM → Solana (burn → release):**
1. User calls `WrappedNave.bridgeBurn(gross, solanaRecipient)` — one signature;
   burns gross, emits `BridgeBurnTo`.
2. `POST /bridge-relay {direction:evm_to_solana, sourceTx}`.
3. `verifyEvmBurn` (receipt success + ≥5 conf) → `netFromGross` → `releaseNaveOnSolana`
   → `nave_bridge.release` pays `net`, resolves fee, writes `ProcessedRelease`
   (replay key `(chainId, burnTxHash)`).

**Recovery:** if the POST is lost or the destination leg fails, the row is
`pending`/`failed`; the bridge watcher re-drives it (bounded by `retry_count`,
then `stuck`), and the missed-event scan enqueues events with no row. On-chain
replay guards make any duplicate destination attempt revert harmlessly.

---

## 6. Lifecycle: stake → claim → unstake (+ reward funding)

1. **Stake:** Solana `nave_staking.stake(amount)` (ticks drip, accrues, pulls
   principal into `stake_vault`, persists `UserStake.bump`) / EVM
   `approve` + `NaveStaking.stake(amount)`.
2. **Reward funding:** bridge's 1% staking leg accrues in the Solana collector →
   `runStakingMirror` splits it by live stake weight → Solana `reward_vault` (+
   `sync`) and each EVM `notifyReward` (opens/rolls a 365-day drip window).
3. **Claim:** `claim()` ticks drip, accrues, pays `min(pending, vault/available)`
   (solvency-capped; principal never paid out).
4. **Unstake:** `unstake(amount)` returns principal (available even while paused).
