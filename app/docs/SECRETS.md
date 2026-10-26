# Secrets Inventory & Rotation Runbook

This documents every secret the Nave platform depends on, where it lives, and
how to rotate it. No secret should ever be committed to source. The frontend
only receives `VITE_`-prefixed values at build time; everything else is a
server-side secret provisioned in the relevant runtime's secret store.

## Inventory

| Secret | Type | Where it lives | Consumed by |
| --- | --- | --- | --- |
| `VITE_SUPABASE_ANON_KEY` | Public client credential | Frontend build env | Browser → Supabase (RLS-gated) |
| `VITE_SUPABASE_URL` | Public endpoint | Frontend build env | Browser |
| `SUPABASE_SERVICE_ROLE_KEY` | High-privilege credential | Supabase edge secrets, signer env | All edge functions, signer service |
| `NAVE_AGENT_SECRET` | Shared bearer | Supabase edge secrets, agent operator | `agent-orchestrator`, `agent-dispatcher`, `agent-health` |
| `NAVE_SIGNER_SECRET` | Shared bearer | Signer env (Railway), orchestrator edge secret | Signer `/sign`, orchestrator → signer |
| `NAVE_INDEXER_SECRET` | Shared bearer | Indexer env, Supabase edge secrets | `index-events`, `snapshot-treasury`, `helius-webhook` |
| `NAVE_POLICY_SECRET` | Shared bearer | Supabase edge secrets, worker env | `policy-evaluator`, worker policy tick |
| `NAVE_PROPOSER_SECRET` | Shared bearer | Supabase edge secrets, worker env | `proposal-creator`, worker proposal tick |
| `NAVE_MASTER_KEK` | Envelope KEK (base64 32B) | Supabase edge secrets, signer env | Wraps/unwraps agent DEKs |
| Agent DEKs (per DAO/role) | Data keys | Wrapped in `encrypted_agent_keys` | dispatcher, signer (unwrapped via KEK) |
| Program upgrade authority | Solana keypair | Hardware/multisig (see PHASE6) | Program deploys/upgrades |
| `BRIDGE_SOLANA_CUSTODY_AUTHORITY` | Solana keypair | Signer env (Railway) only | Signs custody releases on `/bridge-relay` |
| `BRIDGE_EVM_MINTER_PRIVATE_KEY` | EVM EOA private key | Signer env (Railway) only | Mints/burns WrappedNAVE on `/bridge-relay` |
| `FAUCET_WALLET_SECRET` | Solana keypair | Signer env (Railway) only | Sends devnet NAVE on `/faucet-claim` and devnet SOL on `/faucet-claim-sol`; dedicated wallet, separate from bridge custody and any deploy/ops wallet |
| `NAVE_GENLAYER_SIGNER_KEY` | GenLayer EOA private key | Supabase edge secrets only | Submits `open_case`, `review_venue`, and `open_appeal`. Holds no Nave treasury authority |
| `COMPASS_ADMIN_PASSWORD` | Operator password | Supabase edge secret only | `compass` function. Username is `captain`. Not a Supabase Auth user, and not present in the frontend bundle |

> The bridge and faucet wallets are intentionally **separate keys with separate roles** — a compromised faucet key cannot touch bridge custody, and vice versa. Neither is ever sent to the browser; `/bridge-relay` and `/faucet-claim` are public-but-verifying endpoints that independently re-check on-chain state rather than trusting the caller (see `docs/portal/tokenomics.md` for the trust model).

### Continuous-loop feature flags (not secrets, but operationally critical)

| Flag | Default | Effect |
| --- | --- | --- |
| `NAVE_AUTOPROPOSE_ENABLED` | `false` (observe-only) | When `true`, `proposal-creator` actually creates on-chain Strategy proposals from recommendations. When unset/false it only reports candidates. |
| `NAVE_PROPOSER_ROLE` | `planner` | `encrypted_agent_keys.agent_role` used as the proposal proposer. Keep distinct from the 4 pipeline roles (separation of duties). This key must be funded (pays proposal rent). |
| `NAVE_YIELD_SOURCE_URL` | unset | Optional external yield-data source for the scanner; falls back to the conservative built-in table when unset. |
| `POLICY_INTERVAL_MS` / `PROPOSAL_INTERVAL_MS` | `600000` | Worker cadences for the policy + proposal ticks. |
| `NAVE_GENLAYER_GATE` | `false` | Charter fail-closed for signing roles. A finished pass does not authorize a transfer. See `docs/GENLAYER.md`. |
| `NAVE_GENLAYER_VENUE_GATE` | `false` | A finished venue `stop` withholds a new deploy. |
| `NAVE_GENLAYER_HALT_GATE` | `false` | A finished `keep_pause` blocks clear. `lift_pause` does not sign. |
| `NAVE_GENLAYER_RPC_URL` | `https://rpc.testnet-chain.genlayer.com` | GenLayer Phase 2 RPC. Not a secret. Required with the signer key and the three contract addresses before any review is written. |
| `NAVE_GENLAYER_CHARTER_ADDRESS` | `0xa893D572dAA073569e5C30BDB151165071d0AdaB` | CharterAdjudicator on Bradbury Phase 2. |
| `NAVE_GENLAYER_VENUE_ADDRESS` | `0x020ac4d4940D87579BAC0b888A47fe3Aae106334` | VenueWatch on Bradbury Phase 2. |
| `NAVE_GENLAYER_HALT_ADDRESS` | `0xCD1345c5DD1Fb61ce70794633ff0Fdb9A69f124D` | HaltAppeal on Bradbury Phase 2. A missing address means the dispatcher skips the submit and writes no row. |

> The `planner` proposer key is a real signing key held by the signer service.
> It can ONLY create Strategy proposals; it has no approval/execution authority.
> Rotate it like any other agent keypair (see Master KEK / agent rotation flow).

## Known exposure to remediate (P0)

The following were previously hardcoded in source or committed env and MUST be
rotated before mainnet:

- `VITE_SUPABASE_ANON_KEY` — was embedded in `src/lib/programConfig.ts`. Removed
  from source; **rotate the anon key in the Supabase dashboard** (Project
  Settings → API → roll anon key) and update deployment env.
- `NAVE_AGENT_SECRET`, `NAVE_SIGNER_SECRET`, `NAVE_INDEXER_SECRET` — were all set
  to the same value in a local `.env`. Generate three **distinct** high-entropy
  secrets and set them in each runtime.

## Rotation procedures

### Shared bearer secrets (`NAVE_*_SECRET`)

1. Generate: `openssl rand -hex 32`.
2. Set in every consumer simultaneously (orchestrator/dispatcher/health share
   `NAVE_AGENT_SECRET`; signer + orchestrator share `NAVE_SIGNER_SECRET`;
   indexer functions share `NAVE_INDEXER_SECRET`; `policy-evaluator` + worker
   share `NAVE_POLICY_SECRET`; `proposal-creator` + worker share
   `NAVE_PROPOSER_SECRET`):
   - Supabase: `supabase secrets set NAVE_AGENT_SECRET=...`
   - Or sync RPC + indexer from `.env.local` (VITE\_\* → edge names): `npm run secrets:sync-edge-rpc` (see `scripts/sync-supabase-edge-rpc-secrets.mjs`).
   - Railway (signer): set in service variables, redeploy.
3. Verify with a health/probe call, then invalidate the old value.

### Supabase anon key

Roll in the dashboard, update `VITE_SUPABASE_ANON_KEY` in the frontend build
env, and redeploy the frontend. Old key stops working immediately.

### Service role key

Roll in the dashboard. Update edge secrets and signer env. This is the most
disruptive rotation — schedule a maintenance window.

### Master KEK (`NAVE_MASTER_KEK`)

The KEK wraps every agent DEK. Rotating it requires re-wrapping all DEKs:

1. Generate new KEK: `openssl rand -base64 32`.
2. Run the re-wrap job (see [`scripts/rotate-kek.md`](../scripts/rotate-kek.md) and `scripts/rotate-kek.mjs`): for each active row in
   `encrypted_agent_keys`, unwrap `wrapped_dek` with the OLD KEK and re-wrap
   with the NEW KEK, writing back `wrapped_dek/dek_wrap_iv/dek_wrap_tag`.
3. Swap `NAVE_MASTER_KEK` in edge + signer env.
4. Never delete agent rows; rotation of the underlying agent keypair is a
   separate flow (insert new active row, set old `is_active=false`).

### Bridge / faucet keys

`BRIDGE_SOLANA_RELAYER_AUTHORITY` (formerly `BRIDGE_SOLANA_CUSTODY_AUTHORITY`), `BRIDGE_EVM_MINTER_PRIVATE_KEY`, and `FAUCET_WALLET_SECRET` are plain signing keys (not envelope-wrapped) read directly from the signer's Railway env. To rotate any of them:

1. Generate a new keypair/EOA out-of-band.
2. Fund the new key (SOL for fee/rent on Solana keys; ETH for gas on the EVM relayer).
3. Update the Railway variable and redeploy.
4. Sweep any remaining balance from the old key once the new one is confirmed live.

## Mainnet bridge key management (hardened design)

The mainnet-hardened bridge removes the "single hot key drains everything"
posture. Value now moves through on-chain programs whose *administrative* power
sits behind a multisig, while the relayer holds only a bounded execution key.

### Roles, keys, and where they live

| Role | Chain | Key / authority | Powers | Where |
| --- | --- | --- | --- | --- |
| `nave_bridge` config `owner` | Solana | **Squads multisig** | set fee/caps/pause, rotate relayer, transfer ownership | on-chain PDA `BridgeConfig` |
| `nave_bridge` config `relayer` | Solana | relayer hot key (`BRIDGE_SOLANA_RELAYER_AUTHORITY`) | call `release` only, bounded by pause + per-tx + daily caps + replay guard | KMS/HSM, referenced from signer env |
| `nave_staking` pool `owner` | Solana | **Squads multisig** | pause, transfer ownership | on-chain PDA `StakePool` |
| `WrappedNave` `owner` | EVM | **Safe multisig** | rotate minter (2-step), set `supplyCap`, `mintPaused`, freeze, `renounceControl` | on-chain |
| `WrappedNave` `minter` | EVM | **`NaveBridge` lockbox** (contract) | mint (only via lockbox `bridgeIn`, itself capped/paused/replay-guarded) | on-chain |
| `NaveBridge` lockbox `owner` | EVM | **Safe multisig** | pause, set caps, rotate relayer, transfer ownership | on-chain |
| `NaveBridge` lockbox `relayer` | EVM | relayer EOA (`BRIDGE_EVM_MINTER_PRIVATE_KEY`) | call `bridgeIn` only, bounded by caps + replay | KMS/HSM, referenced from signer env |
| `NaveStaking` `owner` / `rewarder` | EVM | Safe multisig / relayer EOA | pause / deliver reward top-ups | on-chain |

Key property: a compromised relayer key can, at worst, move up to the per-tx
and rolling daily caps and cannot exceed the wNAVE `supplyCap` — it cannot
change fees, lift caps, unpause, or drain custody. Those require the multisig.

Two blast-radius nuances to size caps against (from the security review):

- **Daily cap is a resetting window, not a sliding sum.** At the boundary a
  compromised relayer can spend one full `daily_cap` just before the 24h reset
  and another immediately after — up to **~2 × daily_cap in seconds**. Size
  `daily_cap` at half your true tolerable daily loss, or treat 2× as the real
  bound. (This is intentional/simple; a sliding accumulator is a future option.)
- **`supplyCap` is per EVM chain; Solana custody is one pool.** With N wNAVE
  deployments, the theoretical unbacked mint ceiling under a compromised
  relayer is **sum(supplyCap across chains)**, which must be `<=` the NAVE that
  can actually be released from the single Solana custody. Set each chain's
  `supplyCap` so the sum never exceeds bridgeable custody backing.

### KMS/HSM custody of the relayer keys

Do NOT store the relayer signing keys as plaintext env on mainnet. Options, in
order of preference:

1. **Cloud KMS with an in-process signer shim** (AWS KMS / GCP KMS): the private
   key never leaves the HSM; the signer service calls KMS to sign the release /
   `bridgeIn` transactions. EVM: use a KMS-backed viem `account`. Solana: use a
   KMS-backed signer that returns the 64-byte signature for the release tx.
2. **Hardware signer / Fireblocks-style vault** for the EOA, with an allow-list
   restricting the relayer key to the lockbox `bridgeIn` selector and the
   `nave_bridge` `release` instruction.
3. If a KMS integration is not yet wired, keep the key in a dedicated secret
   manager (not shared env), scope it to the signer service only, and set tight
   caps so the bounded blast radius compensates.

### Rotation

- **Relayer key (either chain):** generate the new key in KMS; the multisig
  calls `set_relayer` (Solana) / `setRelayer` (EVM lockbox); update the signer
  env to point at the new KMS key ref; redeploy; retire the old key. The active
  relayer keeps working until the multisig repoints, so there is no downtime.
- **wNAVE minter:** two-step — multisig `setMinter(newLockbox)` then the new
  lockbox `acceptMinter()`. Never leave the minter unset.
- **Multisig owners:** rotate signers within Squads/Safe per their own policy;
  the on-chain `owner` pubkey (the multisig) does not change.

### Emergency response (break-glass)

1. **Pause** via the multisig: `nave_bridge.set_paused(true)` + lockbox
   `setPaused(true)` (halts inbound mints; user exits/burns stay open) and
   `WrappedNave.setMintPaused(true)`.
2. If a specific account is implicated, `WrappedNave.setFrozen(account, true)`
   while control is still active.
3. Investigate; rotate the relayer key if it was the vector.
4. Unpause once safe. When the bridge is fully decentralized, call
   `WrappedNave.renounceControl()` to permanently give up the freeze lever.

### Compass operator password (`COMPASS_ADMIN_PASSWORD`)

`/compass` is the operator console. It has one username, `captain`. The password
is only `COMPASS_ADMIN_PASSWORD` on the Supabase edge function. The browser
stores a signed session for eight hours and never receives the password, the
service role key, payroll rows, bank tokens, customer documents, or signing keys.

1. Choose a password of 12 to 200 characters.
2. From `app/`: `supabase secrets set COMPASS_ADMIN_PASSWORD='...' --project-ref <project>`.
3. New login attempts pick up the new value. Existing sessions remain valid
   until sign-out or the eight-hour expiry. Rotating `SUPABASE_SERVICE_ROLE_KEY`
   invalidates every Compass session, because the session token is signed with it.
4. Eight failed attempts from one address within 15 minutes are rejected.
   Thirty subscription grants per hour is the ceiling.

A Compass grant records a Nave Pay term with source `compass`. It does not
collect USDC and it does not call the book-deletion path.

## CORS allow-list

`NAVE_ALLOWED_ORIGINS` (comma-separated) restricts which browser origins may
read edge function responses. Leave unset only in local development; set it in
every deployed environment. Include every public frontend origin, for example
`https://nave.finance,https://www.nave.finance`. The edge helper treats apex and
`www` variants of an explicitly allowed origin as equivalent, but listing both
keeps the deployed setting easy to audit.
