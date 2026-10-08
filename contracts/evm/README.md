# Nave EVM Contracts (Ethereum + Base)

Solidity (Foundry) port of the Nave agent-governed DAO-treasury protocol from
Solana to **Ethereum (`1`)** and **Base (`8453`)**, with testnets **Sepolia
(`11155111`)** and **Base Sepolia (`84532`)**. This is **Part A** of the
multi-chain plan: the smart contracts only.

## Architecture

Protocol singletons (`NaveProtocol`, `NaveDAOFactory`, bridge stack, oracle,
stake) are **UUPS** (`ERC1967Proxy`) owned by a Safe after handoff.

Each DAO is three **UUPS proxies** (Treasury / Governor / Execution). The
protocol publishes approved + latest implementations; existing DAOs upgrade
**only with their own governance consent** (`ProposalType.ContractUpgrade`).
An off-chain upgrade monitor auto-opens proposals for active DAOs; the app
falls back to a one-tap “Create upgrade proposal” notification.

| Contract | Role | Solana analogue |
|---|---|---|
| `NaveProtocol` | singleton config + DAO registry + impl registry + fee sink | `NaveGlobalConfig` + `ProtocolFeeVault` |
| `NaveDAOFactory` | `createDao` (UUPS proxies + formation fee) | three-step `initialize_dao*` |
| `NaveTreasury` | custody, fees, assets, agents, guardians, constitution, positions | DAO-level `nave_core` |
| `NaveGovernor` | proposals + voting + ContractUpgrade execute | `nave_governance` |
| `NaveExecution` | four-agent pipeline + Transfer handler + adapter calls | `nave_execution` |
| `PythOracle` | Pyth (32-byte feed ids, 60s, 2% conf) + Chainlink fallback | `utils::oracle` |
| `adapters/*` | `Aave v3`, `Compound v3`, `Balancer v2` behind `IStrategyAdapter` (Curve source is dormant until a vetted deployment exists) | `nave_jito/kamino/marginfi` |

Heavy founder-config logic lives in `TreasuryAdminLib` (a DELEGATECALL-linked
library) to keep `NaveTreasury` under the EIP-170 24KB runtime limit.

Publish new DAO logic without mutating live DAOs:

```bash
PROTOCOL_ADDRESS=0x... forge script script/PublishDaoImpls.s.sol --rpc-url <chain> --broadcast
```

Upgrade a singleton UUPS proxy:

```bash
PROXY_ADDRESS=0x... TARGET=protocol forge script script/UpgradeUups.s.sol --rpc-url <chain> --broadcast
```

### Testnet → mainnet rehearsal (operator)

1. Redeploy UUPS stack on Base Sepolia / Sepolia via
   `npm run mainnet:cutover:evm -- --env <env> --chain-id 84532 --phase all`.
2. Safe `acceptOwnership()` on protocol/factory/oracle/daoStake (+ bridge).
3. `PublishDaoImpls` → upgrade monitor auto-proposes → vote → **Apply update**.
4. Repeat on mainnet `8453` / `4663`: deploy UUPS **v2** into
   `hardened-bridge-<id>.json` / `<id>.json`. Keep immutable bridge **v1** live
   for exit liquidity in `hardened-bridge-v1-<id>.json` (do **not** pause or
   orphan v1 while supply remains). App primary `VITE_*` / `BRIDGE_EVM_*` → v2;
   legacy `*_V1_*` env lets the relayer accept v1 burns. Enable
   `EVM_UPGRADE_PROPOSER_PRIVATE_KEY` on Railway.

See `nave-app/docs/MAINNET_PREFLIGHT.md` §4d-1.

## Build & test

```bash
forge build                 # compiles clean (via-IR, size-optimized)
forge test                  # unit + invariant suites (fork tests skip w/o RPC)
forge fmt --check           # formatting gate

# Mainnet-fork adapter tests. Balancer requires operator-quoted non-zero
# slippage floors for the selected pools.
ETH_MAINNET_RPC_URL=... BASE_MAINNET_RPC_URL=... \
BALANCER_MIN_BPT_OUT=... \
forge test --match-path test/ForkAdapters.t.sol
```

## Deploy

```bash
PROTOCOL_OWNER=0x... PROTOCOL_TREASURY=0x... PYTH_ADDRESS=0x... \
FORMATION_FEE_WEI=100000000000000000 TOKEN_MINT_FEE_WEI=50000000000000000 \
forge script script/Deploy.s.sol --rpc-url <chain> --broadcast --verify
```

Hand `NaveProtocol` ownership to a Safe per chain after deploy (cutover phase).

## Testnet Adapter Support

`script/config/NaveAddressRegistry.sol` pins only official protocol singletons
that are usable by the current Nave adapters:

| Chain | Aave V3 | Compound V3 | Balancer |
|---|---|---|---|
| Sepolia (`11155111`) | Supported: Pool `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` from Aave address book | Supported: cUSDCv3 Comet `0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e` from Compound Comet deployments | Configurable after a compatible Nave Balancer adapter is deployed. Official Balancer v3 core contracts exist on Sepolia, but `BalancerAdapter` targets the v2 Vault ABI plus concrete pool args. |
| Base Sepolia (`84532`) | Supported: Pool `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` from Aave address book | Unsupported unless a real Base Sepolia Comet is supplied. No official `compound-finance/comet/deployments/base-sepolia/usdc` artifact was found. | Configurable only after a compatible Nave Balancer adapter and concrete pool tuple are deployed. |

Sources used:

- Aave address book: `https://github.com/aave-dao/aave-address-book`
- Compound III networks docs: `https://docs.compound.finance/#networks`
- Compound Comet deployments: `https://github.com/compound-finance/comet/tree/main/deployments`
- Balancer deployments registry: `https://github.com/balancer/balancer-deployments`

## Parity

[`FEATURE_PARITY_MATRIX.md`](./FEATURE_PARITY_MATRIX.md) maps **every** Solana
instruction to its EVM function and test — the "no feature missed" gate.
