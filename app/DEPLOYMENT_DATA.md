# Nave Deployment Data — Base + Robinhood Mainnet (mixed)

Fill the **Operator inputs** fenced `env` block below. Everything else is
documented defaults. **Never put private keys, API secrets, or KEKs in this file.**

## Profile (fixed)

| Network | Environment | Chain ID | Role |
|---------|-------------|----------|------|
| Solana | **Devnet** | — | DAOs / treasury (deferred mainnet) |
| Ethereum | **Sepolia** | `11155111` | DAOs / bridge testnet |
| Base | **Mainnet** | `8453` | DAOs + bridge/stake |
| Robinhood Chain | **Mainnet** | `4663` | DAOs (bridge-out yield) + bridge/stake |

```
VITE_EVM_NETWORK=mixed
```

Solana mainnet and Ethereum mainnet deploys are **out of scope** for this cutover.

---

## Operator inputs (edit only this block)

```env
# ── Required for cutover ────────────────────────────────────────────────────
# Safe that will own Base + Robinhood contracts after handoff (must have bytecode).
SAFE_ADDRESS=0xd338C8d0C3e28979D1cFec2f7C66769C796db89c

# Hot relayer/rewarder EOA — MUST differ from SAFE_ADDRESS.
# Example format only — replace with your real relayer before validate passes:
STACK_RELAYER=0x0000000000000000000000000000000000000000

# Public RPCs (no API keys in browser-facing VITE_ vars).
EVM_BASE_RPC_URL=
EVM_ROBINHOOD_RPC_URL=
VITE_EVM_BASE_RPC_URL=
VITE_EVM_ROBINHOOD_RPC_URL=
VITE_EVM_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Solana stays on DEVNET.
VITE_SOLANA_RPC_URL=

# Explorer verify (Base only; Robinhood uses Blockscout, no key).
BASESCAN_API_KEY=

# WalletConnect Cloud project id (required once any mainnet EVM chain is live).
VITE_WALLETCONNECT_PROJECT_ID=

# Caps (6-decimal NAVE base units). Defaults match hardened-bridge artifacts.
STACK_SUPPLY_CAP=100000000000
STACK_PER_TX_CAP=1000000000
STACK_DAILY_CAP=10000000000

# Optional: Base DAO stack (omit to deploy bridge/stake only on Base first).
# CUTOVER_BASE_SCOPE=full
# PROTOCOL_TREASURY=
# PYTH_ADDRESS=
# TOKEN_MINT_FEE_WEI=50000000000000000
```

Secrets stay in gitignored env files only:

| Secret | Where |
|--------|--------|
| `EVM_DEPLOY_PRIVATE_KEY` | contracts cutover env (never commit) |
| `NAVE_EVM_MASTER_KEK` / signer secrets | Railway / Supabase (never commit) |

---

## Known addresses (pre-filled — update after re-deploy)

### Base mainnet — `8453` (DAO + bridge/stake)

| Contract | Address |
|----------|---------|
| WrappedNave | `0xFc04710C3F310f6ed84b441cf897a05807312358` |
| NaveBridge | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` |
| NaveStaking | `0xC8f3BD11a62D39133DdFb5D653789eAe9d8630ec` |
| NaveProtocol | `0x377D976A31871060B4059fA244b76809A3Cc0C90` |
| NaveDAOFactory | `0x280470c7275d630f1a9Fc1C406D4754D1f523Dbb` |
| AaveV3Adapter | `0x2D4FaC2d91aE21ace6F24B5B288BC919f4685Dc1` |
| CompoundV3Adapter | `0x5c99A7a1934A95D650c62B639EED2234211a0Ad8` |

After Base **full** DAO deploy, record:

| Contract | Address |
|----------|---------|
| Balancer adapter | _optional — only after validated getRate() pool_ |

### Robinhood Chain mainnet — `4663` (DAO + bridge-out + stake)

| Contract | Address |
|----------|---------|
| WrappedNave | `0xFc04710C3F310f6ed84b441cf897a05807312358` |
| NaveBridge | `0x608c6Ee3d56C4Ac5241D5481E72bD236C5404654` |
| NaveStaking | `0xC8f3BD11a62D39133DdFb5D653789eAe9d8630ec` |
| ArbitrumBridgeAdapter (WETH → Eth) | `0xE397b5e27Ae892101435fCB74E6Ed949efD46ef1` |

> Local Aave/Compound are N/A on RH. Agents bridge WETH to an Ethereum sister treasury.
> Confirm on-chain that these are live on **each** chain (addresses may match across L2s when CREATE2/identical deploys were used). Re-run cutover if you need a fresh hardened stack.

### Ethereum Sepolia — `11155111` (unchanged testnet)

| Contract | Address |
|----------|---------|
| Protocol | `0x678e69c53E53904ca6D060040E14DFc56003BC11` |
| Factory | `0x4C8dBdEaa7f5B043dB9A8831023b67994Dc2cb36` |
| WrappedNave | `0x1d1d988e8ffE542f1f8F7932DE3A634251D4A042` |
| Bridge | `0xd5695B76602A288090f3a630dfBca23912cff76d` |
| Staking | `0x9BdE2F925fb71bDfC3EA0F0F9617786b5a642F02` |

---

## One-command cutover

From `nave-app/`:

```bash
# 1) Fill Operator inputs above, then:
npm run cutover:base-rh -- --phase validate

# 2) Deploy contracts (needs EVM_DEPLOY_PRIVATE_KEY in the env file you pass):
npm run cutover:base-rh -- --phase deploy --env ../Documents/builds/nave-contracts/.env.cutover --confirm-mainnet

# 3) Write frontend .env snippet + print host hints:
npm run cutover:base-rh -- --phase app-env

# 4) Handoff + verify (Safe must acceptOwnership):
npm run cutover:base-rh -- --phase handoff --env ../Documents/builds/nave-contracts/.env.cutover --confirm-mainnet
npm run cutover:base-rh -- --phase verify --env ../Documents/builds/nave-contracts/.env.cutover --confirm-mainnet
```

Or run everything in order:

```bash
npm run cutover:base-rh -- --phase all --env <path-to-secrets.env> --confirm-mainnet
```

---

## Checklist

- [ ] `SAFE_ADDRESS` ≠ `STACK_RELAYER`
- [ ] Solana RPC is **devnet** (no mainnet)
- [ ] No Ethereum mainnet (`chainId 1`) addresses in app env
- [ ] No Base Sepolia / Robinhood testnet addresses in active VITE_ vars
- [ ] Base + Robinhood RPCs return the expected chain ids
- [ ] Safe `acceptOwnership()` completed on Base (+ Robinhood)
- [ ] Network switcher shows: Solana (Devnet), Ethereum (Sepolia), Base (Mainnet), Robinhood Chain (Mainnet)
