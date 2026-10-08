# Nave — Platform State Assessment & Redeploy Plan (2026-09-05)

Scope: `nave-app` (Vercel frontend, Supabase backend, Railway signer-service + evm-indexer) and
`nave-contracts` (Solana Anchor programs, Foundry EVM contracts). Live infrastructure was probed
directly (Vercel API, Supabase SQL, Railway `/health`, on-chain reads on Solana mainnet/devnet,
Base 8453, Robinhood 4663, Ethereum 1). Code findings were verified against source at
`nave-app@6200773` and `nave-contracts@77747d5`. Prior ledgers (`docs/AUDIT_FINDINGS.md`,
`nave-contracts/AUDIT_LOG.md`, `MAINNET_READINESS.md`) were cross-checked; items below are
**NEW** unless marked DOC.

No code was changed as part of this assessment.

---

## 0. Executive summary

1. **The "pull" was asymmetric and left users exposed.** Only the Solana mainnet `nave_bridge`
   and `nave_staking` programs were closed. Every EVM contract on Base, Robinhood and Ethereum is
   still live and **unpaused**, and the Railway relayer is still running with bridge + staking
   mirror enabled. ~3,016 wNAVE outstanding on EVM can no longer be redeemed; anyone who
   `bridgeBurn`s today loses funds.
2. **~3,689 NAVE is permanently locked on Solana mainnet.** Closed Solana program IDs cannot be
   redeployed. Custody (3,033.845 NAVE, owner PDA `8d7Do6…`) and the stake vault (655 NAVE of
   user principal, owner PDA `5hyY47…`) are controlled by PDAs of closed programs. NAVE mint
   authority is revoked, so they cannot be re-minted. Only the collector (83.357 NAVE, relayer
   EOA) is recoverable. This needs a user-facing remediation decision.
3. **The core product loop cannot execute.** The orchestrator's execute condition checks for
   `decision === "approve"` but the Operational agent schema only allows
   `continue|halt|clear_halt|request_review`, so every in-review request expires
   (`agent-orchestrator/index.ts:2076-2079` vs `agent-dispatcher/index.ts:24,327`).
4. **Three contract-level Criticals must be fixed before any redeploy:** forged `BridgeLock`
   event → unbacked wNAVE mint (relayer); arbitrary-mint token voting on Solana governance;
   EVM `finalizeProposal` stranding escrow on missed quorum.
5. **Authority posture is still P1-violating**: Ethereum bridge `owner == relayer == rewarder`
   (single EOA), v2 lockboxes owned by a deployer EOA, Base/RH "Safe" is 1-of-1, Solana bridge
   was owner==relayer. `deployments/1.json` is an Anvil artifact.
6. **Neon is not part of this system.** All backend state is Supabase project
   `your-project-ref` (65 migrations, 23 edge functions). No Nave database exists in any
   Neon org.

---

## 1. Verified live state (2026-09-05 00:40 PT)

### Hosting

| Layer | State |
|---|---|
| Vercel `nave-app` (`nave.finance`, `www.`) | READY, prod = `main@6200773`. 72 `VITE_*` env vars incl. Robinhood + Ethereum mainnet addresses. |
| Supabase `your-project-ref` | 65 migrations applied (matches repo). 23 edge functions ACTIVE. `pg_cron`: daily snapshot, nonce prune, **`/staking-mirror/run` every 30 min**, daily simulation refresh. Advisors: `nave_refresh_simulation_batch()` and `get_platform_treasury_stats()` are anon-executable SECURITY DEFINER. |
| Railway signer (`nave-server-production`) | `/health` ok. `isMainnet: true`, **bridge enabled** on chains [1, 4663, 8453], watcher enabled, **staking mirror enabled**, faucet off, swap off. Advertises **devnet** core/governance/execution program IDs while on a mainnet RPC. `/bridge-queue`: 3 failed (all testnet, Jul), 0 stuck. |
| Railway evm-indexer (`evm-indexer-production`) | ok; indexing 1, 8453, 4663. |
| DB contents | `dao_registry`: **2 rows** (1 Solana devnet, 1 Sepolia) — **zero mainnet DAOs**. `bridge_transfers`: 45 (42 completed, 3 failed). Mainnet bridge volume Jul 10–16 only. |

### On-chain

| Chain | Contract | State |
|---|---|---|
| Solana mainnet | `nave_bridge` Fu3Zp…, `nave_staking` AxVdB… | **CLOSED** (irreversible). |
| Solana mainnet | custody `Cww4x…` | 3,033.845 NAVE, owner = closed-program PDA → **locked** |
| Solana mainnet | stake vault `9xpDB…` | 655 NAVE (user stakes), owner = closed-program PDA → **locked** |
| Solana mainnet | collector `GU6f4…` | 83.357 NAVE, owner = relayer EOA `ik4dE…` (0 SOL) → recoverable |
| Solana mainnet | NAVE mint `EGg56…` | supply 499,698.10; mint + freeze authority **revoked** |
| Solana devnet | all 8 programs | live, upgrade authority = deploy EOA `EJ9qp…` |
| Base 8453 | wNAVE `0xFc04…` | live, `mintPaused=false`, supply 1.488, minter = **v2 lockbox** `0x4C06…`, owner = Safe |
| Base 8453 | lockbox v1 `0x608c…` / v2 `0x4C06…` | both **unpaused**, relayer `0x7458…`; v2 perTx 1,000 / daily 25,000 |
| Base 8453 | Protocol/Factory/Staking (UUPS) | live, owner = Safe, `requiredNaveStake` = 472.01 wNAVE, `daoStake` set |
| Robinhood 4663 | wNAVE `0xFc04…` | live, `mintPaused=false`, supply **3,001.49**, minter = v2 `0xD6d3…`, owner = Safe |
| Robinhood 4663 | lockbox v1 / v2, Protocol, Factory, Staking | all live, unpaused, owner = Safe |
| Ethereum 1 | wNAVE / bridge `0x608c…` / staking `0xC8f3…` | live, unpaused, supply 13.37, **owner == relayer == rewarder == `0xFf88…`** (EOA) |
| Ethereum 1 | `deployments/1.json` protocol/factory | **Anvil default addresses; no code on mainnet** |
| Safe `0xd338…` (Base/RH) | | **threshold 1, single owner `0x1FA9…`** (also the EVM referrer-fee payee) |
| Relayer gas | Base/RH `0x7458…` 0.00025 ETH; Eth `0xFf88…` 0.00002 ETH; Solana relayer/authority 0 SOL | effectively unfunded |

Note on `hardened-bridge-{8453,4663}.json`: they record the v2 lockbox owner as deployer EOA
`0xC00C…` and status `primary-awaiting-minter-rotation`; live chain shows owner = Safe and minter
already rotated to v2. Artifacts are stale relative to chain.

---

## 2. Findings by focus area

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. Citations are `file:line`.

### 2.1 Multi-chain operations

- **C** Supabase CHECK constraints on `dao_registry`, `treasury_snapshots`, `agent_action_logs`,
  `monthly_reports`, `watched_daos`, `encrypted_evm_keys` still only allow
  `chain IN ('solana','ethereum','base')` / `chain_id IN (1,8453,11155111,84532)`
  (`1781300000-add_chain_discriminator.sql:63-68`, `1781300200-create_encrypted_evm_keys.sql:24-25,43-46`;
  `1783400000-add_robinhood_chain.sql` widened only `evm_indexer_cursors`/`activity_logs`).
  `register-dao`, `generate-evm-agent-keys`, `snapshot-treasury` all insert `robinhood`/`4663`
  → every Robinhood DAO creation fails at the DB step.
- **C** `contracts/evm/deployments/1.json` is a local Anvil artifact (authority `0xf39F…`,
  protocol `0xe7f1…`). There is no Ethereum DAO stack, so the "Ethereum sister treasury" corridor
  (`RobinhoodTreasuryNotice`, `_shared/treasuryBridge.ts`) has no destination.
- **C** Bridge relayer resolves `'base'|'robinhood'|'ethereum'` to mainnet/testnet via the
  **Solana** cluster (`bridgeRelayer.ts:256-288`, `programs.ts:72-76`); in `mixed` mode a devnet
  Solana RPC maps Base → Sepolia. Frontend sends family names, not numeric ids
  (`useBridge.tsx:521-524`).
- **H** `programConfig.ts:707-714` Base-Sepolia fallbacks point at the wrong contracts (factory
  fallback = Sepolia oracle). `.env.example:233,242` repeats them.
- **H** `_shared/treasuryBridge.ts:30` finalize allowlist excludes 4663 while corridors define
  1↔4663.
- **H** Cross-chain address reuse (`0x608c…` on 1/8453/4663; `0x9BdE…` = Base-Sepolia protocol
  and Sepolia staking) collides with `dao_registry.dao_onchain_address UNIQUE` and
  `encrypted_evm_keys` unique index lacking `chain_id`.
- **H** Two live Robinhood DAO stacks (`4663.json` vs `evm-launch-4663.json`); `evm-launch-8453.json`
  points at the `do-not-wire` parallel wNAVE stack.
- **M** Public RPC fallback for mainnet Robinhood in edge functions (`_shared/evmFounder.ts:54-58`);
  `snapshot-treasury` health omits 4663; signer defaults Solana RPC to `localhost:8899`;
  `stakingMirror.ts:71-72` hardcodes program ids; `useChain.tsx:72-78` defaults unknown EVM DAOs
  to Ethereum/Sepolia.

### 2.2 Treasury security & operations

- **H** Solana moonlight halt writes `dao_registry.agents_enabled` but every gate reads
  `agent_set.agents_enabled` (`moonlight.rs:159,343` vs `utils/validation.rs:16-17`,
  `nave_execution/src/lib.rs:516,747`) → agents keep deploying capital during wind-down.
- **H** Signer `jupiter_swap` bypasses the on-chain vault swap: builds via Jupiter API with
  `userPublicKey = agent`, signs the returned tx, skips `sendAgentV0` allowlist
  (`signer-service/src/index.ts:2345-2517`). Off by default (`NAVE_SWAP_ENABLED`).
- **H** EVM `emergencyPauseAgents` (founder **or any one guardian**, `NaveTreasury.sol:590-594`)
  enables `executeDirect`, which accepts `InReview` without `reviewEnd` and covers **Transfer and
  Bridge** kinds (`NaveExecution.sol:450-461,515`) → review-window bypass to external recipients.
- **H** EVM DAO creation sets guardians `[founder, Nave-custodied guardian]`, threshold **1**
  (`CreateDAO.tsx:1820-1835,2032`); custodied guardian + all 4 agent keys sit under the same KEK
  and `X-Signer-Secret` → signer compromise = every emergency lever.
- **M** `snapshot-treasury` derives 3-seed escrow/position PDAs; on-chain uses 4 seeds incl.
  mint (`snapshot-treasury/index.ts:432-434` vs `strategy.rs:76,142`) → reconciliation reads 0
  and every invariant "passes". Same 3-seed bug in signer `update_strategy_position_value`
  (`index.ts:3480`, `programs.ts:250-254`) → marks never land.
- **M** SEC-H4 route containment skips Token-2022 accounts (`jupiter_swap.rs:159-172`);
  `expected_amount_out` is self-supplied (circular slippage floor).
- **M** Founder can set review window to 60 s and approve any adapter address on EVM
  (`NaveTreasury.sol:459-463`, `TreasuryAdminLib.sol:181-215`); `UPGRADE_TO_LATEST` consents to a
  moving target (`NaveGovernor.sol:491-513`, `NaveProtocol.sol:188-195`).
- **M** Direct Operational CPIs (`jupiter/kamino/jito/marginfi_deposit`) bypass the 3-agent
  pipeline and enforce only NAV freshness on-chain (`jupiter.rs:19-32,71-157`).
- **L** EVM Pyth requires ≤60 s updates but nothing posts them → `revalueTreasury` reverts
  (fail-closed DoS) without a funded keeper.

### 2.3 Treasury / DAO formation & governance

- **C** Solana `lock_tokens_and_vote` accepts any SPL mint: `dao_token_mint` unconstrained,
  `Proposal` does not store the mint (`nave_governance/src/lib.rs:180-232,989-1004`) → unlimited
  vote weight with a worthless token. EVM binds `prop.votingMint` correctly.
- **H** EVM `finalizeProposal` reverts `QuorumNotMet` after `votingEnd` so status stays `Active`
  and `releaseVoteEscrow` reverts forever unless the proposer cancels
  (`NaveGovernor.sol:246-276,233-236,286-293`).
- **H** EVM moonlight cross-cycle replay (P6-3) still open: `NaveDaoStake.sol:98-163` never marks
  proposals consumed. Solana fix exists in source but was never shipped.
- **H** Policy loop is Solana-only (`policy-evaluator/index.ts:105-134` decodes Solana PDAs;
  `proposal-creator` → signer `create_proposal` Solana-only) while DAO creation is EVM-only
  (`USER_CHAINS=['base','robinhood']`) → creatable DAOs get zero autonomous policy evaluation.
- **M** `Governance.tsx:63-67` computes `isFounder` from the Solana wallet only → EVM founders never
  see ratify/execute actions. `ActivationHub.tsx:260` same.
- **M** Private DAOs lose all off-chain metadata for everyone incl. founder (RLS
  `privacy_enabled = false`, `1779924597:87-91`; `DaoSlugPage.tsx:60-71` returns not-found).
- **M** Stake requirement is three different numbers: UI `$19`, Solana constant `$99`
  (`DAO_STAKE_TARGET_USD_MICRO`), EVM fixed 472.01 wNAVE with `priceUsdMicro=0`.
- **L** Wallet prompt count copy says "up to 3"; EVM path is 9-10 prompts. Half-initialized
  Solana DAOs possible across the 3-tx init; recovery depends on localStorage.

### 2.4 User experience & journey

- **Blocker** Docs portal says "devnet beta, never touches mainnet funds" (6 pages) while the app
  creates treasuries on Base/Robinhood mainnet and takes real wNAVE + ETH.
- **Blocker** wNAVE dead-end: EVM-only user → stake gate → Bridge → needs Solana wallet + NAVE;
  no buy/DEX link; faucet devnet-only. With the Solana bridge closed this path is now impossible.
- **Blocker** Homepage/docs advertise `$99` stake; runtime is `$19`.
- **H** Hero/footer say "Solana, Ethereum, and Base"; picker offers Base/Robinhood; DevnetBanner
  Solana/Ethereum buttons are immediately reverted (`Index.tsx:79-83`).
- **H** Solana-only address validation silently rejects `0x` guardians on EVM
  (`CreateDAO.tsx:430-440`, `ActivationHub.tsx:50-75`). Dashboard shows "Devnet" for Base DAOs;
  Robinhood DAOs show "Chain 4663" with no explorer.
- **H** Half-finished IA rename (Constitution/Agents/Governance vs Rules/Automation/Votes);
  DAO/Treasury/Vault and NAVE/wNAVE/$NAVE/Nave Shares drift.
- **H** Public docs portal publishes Secrets Inventory, RLS, Runbooks, Beta checklist.
- **M** Landing loads ~3.3 MB of vendor JS (three.js 1 MB, Solana 607 kB, MetaMask 531 kB, wagmi)
  for a marketing page; 28 distinct concepts before first value; `/simulation` unreachable;
  `Moonlight.tsx` and `ActivationChecklist.tsx` are dead files.

### 2.5 Security & auditing

- **H** Replay guard keyed on caller-supplied signature *string* (`dispatch_nonces.signature`);
  verifiers are encoding-tolerant (hex case, base64 trailing bits) → single-use bypass on
  `evm-strategy-withdraw`, `agent-admin`, `evm-guardian-freeze`, `orchestrator-proxy`
  (`orchestrator-proxy/index.ts:205-207` et al.).
- **H** `watch-dao` is unauthenticated: leaks private-DAO membership and lets anyone pollute any
  wallet's watchlist (`watch-dao/index.ts:109-207`).
- **M** `register-dao` / `generate-agent-keys` signatures are static bearer tokens (no
  timestamp/nonce); `generate-agent-keys` exposes `break_glass` raw DEK to that token.
- **M** `generate-evm-agent-keys` bind has no on-chain founder check; `agent-admin`,
  `evm-guardian-freeze`, `evm-strategy-withdraw` still gate on DB `creator_wallet` (H5 fix not
  propagated).
- **M** RLS writes on `dao_token_images`, `dao-logos`, `dao_hidden_assets`, `watched_daos` DELETE
  are gated on the spoofable `x-wallet-address` header (AUDIT_FINDINGS H1/H2 "verified" rests on
  this).
- **M** `X-Forwarded-For` leftmost-IP rate-limit keys (signer + edge) spoofable; anonymous DB
  writes/compute on `nave-price-oracle` (insert per GET) and `simulation-data?refresh=1`.
- **M** `programConfig.ts:24-25,35-36` uses dynamic `import.meta.env[key]` → Vite inlines **all**
  `VITE_*`; local `.env.local` holds `VITE_SUPABASE_SECRET_KEY` (`sb_secret_…`) which is in the
  local `dist/` bundle (not in prod). Rotate + remove.
- **L** Alchemy keys and Vercel git metadata inlined in prod bundle; raw `err.message` leakage on
  several routes; CI has no `npm audit`, secret scan, `deno check`, or RLS tests.
- Live advisor: `nave_refresh_simulation_batch()` anon-executable SECURITY DEFINER (DoS/cost).

### 2.6 AI agent functions & guardrails

- **C** Orchestrator execute condition unreachable (see §0.3) → autonomous execution has been
  dead since commit `506c427` (2026-05-31).
- **H** EVM pipeline dispatch omits `chain`/`chain_id` (`agent-orchestrator/index.ts:1886-1897`) →
  dispatcher defaults to Solana, key lookup fails for every EVM DAO.
- **H** `agent-admin` authorizes founder from DB row (`agent-admin/index.ts:170-178`).
- **H** EVM guardian key server-custodied under the agent KEK (`generate-evm-agent-keys:239-263`,
  `evmSigner.ts:103-153`).
- **M** No LLM timeout or spend ceiling (`agent-dispatcher/index.ts:752-770`); prompt-injection
  surface via DAO name, prior-agent reasoning, `activity_logs.description`; `pollOrchestrator`
  has no cross-replica lease; constitution swap bounds not read by signer;
  `agent_action_logs.raw_claude_response` world-readable.
- Off-chain-only guardrails (bypassable if signer compromised): confidence threshold, risk
  severity, rebalance interval, slippage/size caps, all direct-CPI caps, any daily USD limit
  (none exists).

### 2.7 Authentication & user system

- No Supabase Auth; identity is wallet-only. Two channels: unverified `x-wallet-address` header
  for PostgREST/RLS, and signed challenges for edge functions (formats/expiry in §2.5).
- `agent-health` requires `X-Agent-Secret` but the frontend never sends it → always 401 (dead).
- `register-dao` does not lowercase EVM `authorized_wallets` while access checks compare
  lowercased → checksummed members of private EVM DAOs denied.
- Stale `.env` (ignored) still holds a single shared value for all three `NAVE_*_SECRET`s.

### 2.8 Bridge & staking

- **C** `verifySolanaLock` accepts a `BridgeLock` event from **any** program's `Program data:`
  log; never checks `nave_bridge` was invoked (`bridgeRelayer.ts:398-416`,
  `bridgePrograms.ts:197-238`) → forged event mints unbacked wNAVE up to lockbox caps, then
  `bridgeBurn` drains custody up to Solana daily cap. `missedEventScan` has the same gap.
- **C** (live posture) Ethereum bridge `owner == relayer == rewarder`; Base/RH Safe 1-of-1;
  Solana bridge was owner==relayer (DOC P1, still unresolved on every chain).
- **H** `stakeClaims.ts:581-583` mints via static env lockbox instead of `resolveMintLockbox`;
  reserve→custody transfer executes before the mint → failed claims leave custody
  over-collateralized.
- **H** Solana `lock` has no daily cap and no `dest_chain_id` allowlist (`lib.rs:175-186`) →
  irrecoverable locks to unsupported chains; fees already paid.
- **M** EVM stakers structurally under-credited (`C·S·E/T²` vs `C·E/T`); `S=0` → EVM accrues
  nothing; reserve surplus movable by relayer key.
- **M** `senderSignature` verification is dead code (P6-1 claimed fix not enforced;
  `bridgeRelayer.ts:718-745,827`); recipient is still bound on-chain so no theft, but anyone can
  trigger relays.
- **M** Finality not chain-aware (5 confs ≈ 1 s on Robinhood); retry/receipt race marks delivered
  transfers `stuck`; missed-event lookback 5,000 blocks (~21 min on RH); no Σ supply ≤ custody
  monitor; capital bridge has no return leg or destination-treasury validation.
- **L** Faucet has no in-code cluster guard.

---

## 3. Plan forward

### Phase 0 — Containment (this week, no redeploy)

Decisions/actions requiring the operator (multisig or key holder):

1. **Pause everything EVM-side now.** Via Safe `0xd338…` on Base + Robinhood: `setPaused(true)`
   on lockbox v1 + v2, `setMintPaused(true)` on wNAVE, `setPaused(true)` on staking, and
   `NaveProtocol.pause()`. Via `0xFf88…` on Ethereum: same on `0x608c…`/`0xFc04…`/`0xC8f3…`.
   Rationale: no Solana release path exists; every burn is a loss.
2. **Stop the relayer money loops.** Railway: `BRIDGE_RELAYER_ENABLED=false`,
   `STAKING_MIRROR_ENABLED=false`, `NAVE_BRIDGE_OUTBOUND_ENABLED=false`. Supabase: unschedule
   `cron.job` 4 (`/staking-mirror/run`).
3. **Frontend kill-switch.** Disable `/bridge` and the create-DAO stake gate with an honest
   notice; remove Robinhood/Base "Mainnet live" claims until Phase 3.
4. **Locked-funds remediation decision.** 3,033.845 NAVE custody + 655 NAVE user stakes are
   unrecoverable on-chain. Options: (a) treasury-funded 1:1 redemption of the 3,016 wNAVE and
   655 staked NAVE from remaining protocol NAVE (`GdRMR…`/protocol wallets); (b) snapshot EVM
   wNAVE holders + Solana `UserStake` PDAs and honor claims on the new bridge. Publish a notice.
   Recover the 83.357 NAVE collector with the `ik4dE…` key.
5. **Secrets hygiene.** Rotate `VITE_SUPABASE_SECRET_KEY` and delete it from `.env.local`;
   delete stale `.env`; fund or retire relayer EOAs; confirm `NAVE_EVM_MASTER_KEK` ≠ `NAVE_MASTER_KEK`.
6. **Truth in docs.** Rewrite the six "devnet beta" portal pages and the `$99` copy; move
   Secrets/RLS/Runbooks out of the public portal.

### Phase 1 — Fix-before-redeploy: contracts (both repos)

Solana (`contracts/solana`) — new program IDs are required for bridge/staking;
core/governance/execution can be upgraded in place on devnet, but mainnet is a fresh deploy:
- `nave_governance`: store `token_mint` on `Proposal`; constrain `dao_token_mint` in
  `LockTokensAndVote`; ship `mark_moonlight_proposal_executed`.
- `nave_core`: moonlight handlers flip `agent_set.agents_enabled`; `nave_execution` checks
  `DaoLifecycle`; Token-2022 in SEC-H4; bound zero-base marks; raise `MIN_REVIEW_WINDOW_SECONDS`
  or timelock founder changes; add on-chain caps to direct Operational deposit CPIs (or gate them
  behind an ER).
- `nave_bridge`: `daily_cap` + `dest_chain_id` allowlist on `lock`; `initialize_config` with
  owner = Squads, relayer distinct.
- Tests: add LiteSVM/bankrun program-level tests (currently only pure-math unit tests).

EVM (`contracts/evm`):
- `NaveGovernor.finalizeProposal` → `Failed` on missed quorum; `markExecuted` status precondition.
- `NaveDaoStake` + `NaveGovernor`: moonlight proposal consumption (P6-3).
- `NaveExecution.executeDirect`: Strategy-kind only, require `reviewEnd`; `emergencyPauseAgents`
  M-of-N or freeze-only.
- `updateConstitution` adapters must be in a protocol registry; timelock `setReviewWindow` /
  `setLinkedTreasury`; drop or snapshot `UPGRADE_TO_LATEST`.
- Forge tests for each of the above; keep v1 stacks paused with minters revoked.

### Phase 2 — Fix-before-redeploy: backend & app

Signer-service:
- Scope `BridgeLock` decoding to the `nave_bridge` program frame + require program in
  `accountKeys` (also in `missedEventScan`); negative test with a foreign program.
- Accept numeric `chainId` in `/bridge-relay`; drop cluster-sniffed family resolution.
- `stakeClaims.ts` → `resolveMintLockbox`; mint before reserve→custody or reconcile on failure.
- Chain-aware `BRIDGE_EVM_CONFIRMATIONS_<id>`; on-chain replay-state reconciliation for
  `failed/stuck`; Σ wNAVE supply ≤ custody monitor with auto-pause; lookback ≥ tolerated outage.
- Fix 3-seed PDA derivation (`programs.ts:250-254`); delete or rebuild `jupiter_swap` through the
  on-chain instruction + `sendAgentV0`; `trust proxy`; faucet cluster guard; DB lease on
  `pollOrchestrator`; fail on `localhost:8899` default.

Edge functions:
- Orchestrator: execute on `decision === "continue" && !should_halt && no guardrail failures`;
  pass `chain`/`chain_id` on pipeline dispatch; add orchestrator↔dispatcher contract test in `eval/`.
- Canonicalize `dispatch_nonces` key (sha256 of message or canonical sig bytes).
- `watch-dao`: require the `nave-access` challenge. `register-dao`/`generate-agent-keys`:
  timestamped challenge + nonce; operator-gate `break_glass`. On-chain founder in `agent-admin`,
  `evm-guardian-freeze`, `evm-strategy-withdraw`, `generate-evm-agent-keys bind`.
- `snapshot-treasury`: 4-seed PDAs + per-asset vaults + self-test; add 4663 to health and finalize
  allowlist; remove mainnet public RPC fallback.
- EVM constitution reader + EVM proposal path for `policy-evaluator`/`proposal-creator`.
- LLM: `AbortSignal.timeout`, per-DAO token budget, delimit untrusted prompt fields, cap DAO name.
- Gate `nave-price-oracle` persist and `simulation-data?refresh` behind `X-Indexer-Secret`;
  revoke anon EXECUTE on `nave_refresh_simulation_batch`.

Database (new migrations, deployed via MCP/CLI in the same change):
- Widen all `*_chain_check` / `chain_pair` constraints to include `robinhood`, `4663`, `46630`.
- Chain-scope uniqueness: `dao_registry (chain, chain_id, dao_onchain_address)`,
  `encrypted_evm_keys` unique index + `chain_id`, other single-address unique indexes.
- Move header-gated writes (`dao_token_images`, `dao-logos`, `dao_hidden_assets`,
  `watched_daos` DELETE) behind signed edge functions; make `agent_action_logs.raw_claude_response`
  service-role-only.

Frontend:
- `Governance.tsx`/`ActivationHub.tsx` chain-aware founder detection; EVM address validation;
  network labels per chain; Robinhood explorer; remove baked Base-Sepolia fallbacks; replace
  dynamic `import.meta.env[key]` with static accesses + build assertion against `VITE_*SECRET*`.
- Pick one stake number and enforce it on-chain with the oracle; fix prompt-count copy.

### Phase 3 — Redeploy sequence (use the existing cutover system, updated per
`.cursor/rules/mainnet-cutover-maintenance.mdc`)

1. Update `scripts/mainnet-cutover.mjs`, `mainnet-cutover-env.schema.json`,
   `.env.mainnet.cutover.example`, `docs/MAINNET_PREFLIGHT.md` for: new Solana bridge/staking
   program IDs, `BRIDGE_EVM_CONFIRMATIONS_<id>` ≥ chain-appropriate depth, Safe threshold ≥ 2
   assertion, `NAVE_CLUSTER` required, Robinhood DAO stack scope.
2. Regenerate all `contracts/evm/deployments/*.json` from chain; mark retired stacks
   `status: retired`; delete `1.json`; fix `evm-launch-8453.json`.
3. Authority first: Safe → ≥2-of-3 hardware signers (+ optional timelock); Squads vault on
   Solana; distinct KMS-backed relayer + rewarder; Ethereum stack ownership off `0xFf88…`.
4. Testnet rehearsal via `mainnet:wizard:rehearse` (Sepolia/Base Sepolia/RH testnet) including a
   forged-event negative test and a two-way smoke bridge.
5. Mainnet: deploy Solana bridge/staking (new IDs) **paused**; deploy/upgrade EVM v3 lockbox
   implementations; rotate wNAVE minter; honor Phase 0 remediation claims; unpause via multisig
   only after the tiny-amount two-way smoke passes and Σ-supply monitor is green.
6. Solana DAO stack (core/governance/execution) stays devnet until Phase 1 Solana items and
   program-level tests land; then a separate cutover.

### Phase 4 — UX simplification (parallel with Phase 2)

- One truthful landing sentence; single "Connect wallet" defaulting to Base; one-screen create
  (name, network, optional co-signers); inline "Get wNAVE" with DEX + bridge options; honest
  signature count; drop redundant "Ratify rules" in Quick mode.
- IA: Overview / Assets / Rules / Votes / Settings; canonicalize aliases; one noun ("Treasury"),
  one token spelling per surface.
- Defer three.js/wallet vendor chunks off the landing route; delete dead `Moonlight.tsx`,
  `ActivationChecklist.tsx`; link `/simulation` or remove it.

### Phase 5 — Ongoing assurance

- CI: `npm audit`, gitleaks, `deno check` for functions, RLS policy tests, forge + cargo +
  LiteSVM gates blocking; Slither hard-fail on High.
- Monitoring: worker heartbeat + alert when pending ERs and no dispatcher success in N min;
  Σ wNAVE ≤ custody; relayer gas floors; `/bridge-queue` stuck > 0; cron failure alerts.
- External audit of `nave_bridge`, `nave_governance`, `NaveExecution`, `NaveGovernor` before
  unpausing mainnet with real TVL.

---

## 4. Open decisions for the operator

1. Locked-funds remediation path (Phase 0 §4) and public disclosure timing.
2. Whether Solana DAO treasuries go to mainnet in this cycle or remain devnet-only.
3. Whether direct Operational CPIs remain outside the 3-agent pipeline at mainnet TVL.
4. Target stake requirement ($19 vs $99) and whether it is USD-pegged on-chain.
5. Guardian model: keep a Nave-custodied guardian at all (recommend no), and minimum threshold.
6. Daily-cap window semantics (accepted ~2× boundary vs sliding window).
