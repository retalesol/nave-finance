# Devnet multichain beta (Solana + EVM testnets)

Canonical runbook for exercising **Solana devnet** together with **EVM testnets**
(Ethereum Sepolia `11155111` and Base Sepolia `84532`) against the Nave app,
Supabase edge functions, and the optional **evm-indexer** worker.

## Relationship to the Solana-only gate

Solana **Phase 5** autonomous pipeline, SPL escrow, reconciliation, and
`agent_action_logs` training-field checks remain governed by
[`DEVNET_E2E_GATE.md`](./DEVNET_E2E_GATE.md). Complete those steps there; this
document adds **EVM + indexer + multichain registry** layers on top.

## Security and secrets

- **Never commit private keys**, mnemonics, `SUPABASE_SERVICE_ROLE_KEY`, RPC API
  keys with billing attached, or `NAVE_*_SECRET` material. Use `.env.local`
  (gitignored), Supabase secrets, Railway vars, or CI encrypted variables only.
- If any credential was pasted into chat, a ticket, or a log aggregator, treat
  it as compromised: **rotate** the key in the provider and update every
  deployment that referenced it.
- The anon Supabase key and program IDs in `.env.example` are **public** by
  design; service-role keys and dedicated RPC URLs are not.

## EVM contracts (Sepolia + Base Sepolia)

Deploy from the Foundry package in **nave-contracts** (sibling repo path may
vary):

```bash
cd /path/to/contracts/evm
```

### Environment (per chain run)

`script/Deploy.s.sol` reads:

| Variable | Purpose |
|----------|---------|
| `PROTOCOL_OWNER` | Ownable owner for `NaveProtocol` / oracle (broadcasting key should match or hand off via Safe) |
| `PROTOCOL_TREASURY` | Protocol fee / treasury recipient configured on `NaveProtocol` |
| `PYTH_ADDRESS` | Per-chain **Pyth contract** address (must match the network you broadcast on) |
| `FORMATION_FEE_WEI` | **Testnet:** omit or `0`. **Mainnet:** required = `100000000000000000` (0.1 ETH). Enforced by `evm-mainnet-cutover.mjs` preflight. |
| `TOKEN_MINT_FEE_WEI` | Optional; defaults `0` |
| `HANDOFF_TO_SAFE`, `SAFE_ADDRESS` | Optional Ownable2Step handoff |

Run Foundry against each testnet (separate `PYTH_ADDRESS` and RPC for each):

```bash
# Example — use a funded key for --private-key or ledger; values illustrative only.
export PROTOCOL_OWNER=0x...
export PROTOCOL_TREASURY=0x...
export PYTH_ADDRESS=0x...   # Sepolia Pyth contract for Sepolia; Base Sepolia Pyth for 84532

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast \
  -vvvv
```

Repeat on **Base Sepolia** with that chain’s RPC and `PYTH_ADDRESS`.

### Artifacts → frontend env

The script writes `contracts/evm/deployments/<chainId>.json` (e.g.
`deployments/11155111.json`, `deployments/84532.json`). Map fields to Vite vars
(see [`src/lib/programConfig.ts`](../src/lib/programConfig.ts) and
[`.env.example`](../.env.example)):

| `deployments/*.json` | Vite env |
|----------------------|----------|
| `factory` | `VITE_EVM_SEPOLIA_FACTORY_ADDRESS` / `VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS` |
| `protocol` | `VITE_EVM_SEPOLIA_PROTOCOL_ADDRESS` / `VITE_EVM_BASE_SEPOLIA_PROTOCOL_ADDRESS` |

RPC overrides for the **browser** (optional on testnets; viem can fall back to
public RPC when unset):

| Chain | Env |
|-------|-----|
| Sepolia | `VITE_EVM_SEPOLIA_RPC_URL` |
| Base Sepolia | `VITE_EVM_BASE_SEPOLIA_RPC_URL` |

Keep `VITE_EVM_NETWORK` unset or non-`mainnet` so `ACTIVE_EVM_CHAIN_IDS` resolves
to Sepolia + Base Sepolia. When any factory address is set, you must also set
`VITE_WALLETCONNECT_PROJECT_ID` (RainbowKit); see `.env.example`.

## EVM indexer

See [`evm-indexer/README.md`](../evm-indexer/README.md). Summary:

- **Env:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NAVE_INDEXER_SECRET`
  (must match `index-events`), and per-chain `EVM_SEPOLIA_RPC_URL` /
  `EVM_BASE_SEPOLIA_RPC_URL` (and/or mainnet URLs when applicable).
- **Cursors:** table `evm_indexer_cursors` — migration
  `supabase/migrations/1781300100-create_evm_indexer_cursors.sql`.
- **Chain discriminator:** batches POST to `index-events` with `chain` /
  `chain_id`; see `supabase/functions/index-events/index.ts`. Registry /
  activity tables gained `chain` + `chain_id` in
  `supabase/migrations/1781300000-add_chain_discriminator.sql`. EVM agent key
  envelopes: `1781300200-create_encrypted_evm_keys.sql`.

## register-dao (EVM RPC secrets)

The edge function [`supabase/functions/register-dao/index.ts`](../supabase/functions/register-dao/index.ts)
binds on-chain founder verification for EVM DAOs to JSON-RPC URLs:

| `chain_id` | Secret env |
|------------|------------|
| `11155111` | `EVM_SEPOLIA_RPC_URL` |
| `84532` | `EVM_BASE_SEPOLIA_RPC_URL` |

(`1` / `8453` use `EVM_ETHEREUM_RPC_URL` / `EVM_BASE_RPC_URL` for mainnet.)

Set these with `supabase secrets set` (not `VITE_`).

## Frontend checklist (multichain)

- **ChainSelector** — [`src/components/ChainSelector.tsx`](../src/components/ChainSelector.tsx): Solana / Ethereum / Base family picker on flows such as Create DAO and treasury lobby.
- **useChain + daoChainMemory** — [`src/hooks/useChain.tsx`](../src/hooks/useChain.tsx), [`src/lib/chain/daoChainMemory.ts`](../src/lib/chain/daoChainMemory.ts): an EVM treasury address is the same `0x` shape on Sepolia and Base Sepolia; the app **cannot** infer chain from the address alone. Persist `dao_registry.chain_id` into local memory (`rememberDaoChain`) after creation or registry load so reloads query the correct RPC.
- **Key pages** — confirm `useChain` / `syncFromAddress` / `rememberDaoChain` behavior on Dashboard, Governance, Treasury, Assets, Agent, and Settings when switching between Solana and EVM families.

## Automated checks

For a **resumable operator checklist** (Solana + Sepolia + Base Sepolia, agentic
QA with stop/continue), see [`AGENTIC_E2E_MULTICHAIN_RUNBOOK.md`](./AGENTIC_E2E_MULTICHAIN_RUNBOOK.md).

### Multichain verifier (read-only)

```bash
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
# optional:
export EVM_SEPOLIA_RPC_URL=...
export EVM_BASE_SEPOLIA_RPC_URL=...
export VITE_EVM_SEPOLIA_FACTORY_ADDRESS=0x...   # optional bytecode check
export VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS=0x...
# optional strict registry gate (≥1 DAO per EVM testnet chain_id):
export REQUIRE_EVM_DAOS=true

npm run verify:devnet-multichain
```

- With **only** `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, RPC and factory
  checks are skipped; Supabase counts are advisory unless `REQUIRE_EVM_DAOS=true`.

### Playwright (smoke, no WalletConnect)

```bash
# One-time browser binaries (Chromium only is enough for the default project):
npx playwright install chromium

# Uses Vite dev server from repo root unless PLAYWRIGHT_BASE_URL is set.
# Ensure `.env.local` (or CI env) supplies the same VITE_* vars as local dev.
npm run test:e2e

# Optional UI mode:
npm run test:e2e:ui
```

Tests skip when core `VITE_*` vars are missing; the “chain picker” test skips
unless EVM factories **and** `VITE_WALLETCONNECT_PROJECT_ID` are set.

**Write paths** (DAO creation, governance txs, agent pipeline on EVM) still
need **manual wallet QA** or a follow-up **Synpress**/wallet automation stack —
not required for the smoke suite above.

## Solana gate pointer

After multichain wiring, still execute **Phase 5** Solana evidence and
`npm run verify:e2e-gate` as described in [`DEVNET_E2E_GATE.md`](./DEVNET_E2E_GATE.md).

---

## Live deployment record — 2026-06-04

### Deployer (new key, rotated from compromised key)

| Item | Value |
|------|-------|
| Deployer address | `0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca` |
| Key management | Private key stored offline by operator; never committed |
| Prior key (`0x2a0de4cC...`) | Drained and retired; new key funded from same ETH |

### Ethereum Sepolia (`11155111`)

| Contract | Address |
|----------|---------|
| NaveProtocol | `0x9f290c0d6a45357F141E29B828B8c503f1FA4eB1` |
| NaveDAOFactory | `0x387469073147FC19c778De8780fab28A82Ae43D6` |
| PythOracle (`0xDd24F84d36BF92C65F92307595335bdFab5Bbd21`) | `0x6cED85b36308799EbEB730aC193B10D5830aDc15` |
| NaveTokenDeployer | `0x2315A790c557A5Ec1dD955dCD3B48b7e5f414e39` |
| Treasury impl | `0x9Ca6632083f86E72C301959A0d96CBfeFB412aCa` |
| Governor impl | `0x83b97B59121f635AE9dEb5a8ec5fc301Fd8161Bf` |
| Execution impl | `0xA88073A5553A95B08cf554700f33Efb4c2d74ec8` |

> Deploy TX confirmed on-chain at nonce 9 (nonces 0–8 were cancellations of a prior stuck broadcast). Broadcast: `forge script --legacy --with-gas-price 3gwei` via `ethereum-sepolia-rpc.publicnode.com`.

### Base Sepolia (`84532`)

| Contract | Address |
|----------|---------|
| NaveProtocol | `0x7d60761919b95378B33576bb76B83ebf6984707F` |
| NaveDAOFactory | `0x29337FBE01AB9dc5e17C44a3372ADFBAFd409CdE` |
| PythOracle (`0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`) | `0xf79BA8154DE60A2A0d6630f9c7241ca14af5e4f4` |
| NaveTokenDeployer | `0xD97DA189b08e43BaEFC2d8a0191a7b5bC78F09d7` |
| Treasury impl | `0x4f949037d6b9E991B3a5e805EC34D0aA80010545` |
| Governor impl | `0xAEeC1cA0d8978bc709a3Af9a8E0185eF1220F775` |
| Execution impl | `0x3334fBe32eEe1F9f34C047d90762b3030B5Fe255` |

> Deploy TX confirmed at nonce 0. Broadcast: `forge script --legacy --slow` via `sepolia.base.org`.

### App `.env.local` wiring (set)

```env
VITE_EVM_SEPOLIA_RPC_URL=https://sepolia.drpc.org
VITE_EVM_BASE_SEPOLIA_RPC_URL=https://base-sepolia.drpc.org
VITE_EVM_SEPOLIA_PROTOCOL_ADDRESS=0x9f290c0d6a45357F141E29B828B8c503f1FA4eB1
VITE_EVM_BASE_SEPOLIA_PROTOCOL_ADDRESS=0x7d60761919b95378B33576bb76B83ebf6984707F
VITE_EVM_SEPOLIA_FACTORY_ADDRESS=0x387469073147FC19c778De8780fab28A82Ae43D6
VITE_EVM_BASE_SEPOLIA_FACTORY_ADDRESS=0x29337FBE01AB9dc5e17C44a3372ADFBAFd409CdE
```

> Still needed before EVM UX is active: `VITE_WALLETCONNECT_PROJECT_ID` (RainbowKit).
