# Treasury capital bridges (EVM)

Agent-automated hops of **USDC / ETH / WETH** between Base, Ethereum, and Robinhood toward sister Ethereum treasuries for Aave/Compound yield.

This is **not** the `$NAVE` Solana↔EVM trusted relayer.

## Rails

| Corridor | Asset | Adapter | Deployed |
|----------|--------|---------|----------|
| Base ↔ Ethereum | USDC | `CctpBridgeAdapter` (Circle CCTP) | **8453:** `0x0a32e918094ce9fC1CcDbe232e528a88a9c44c20` |
| Base ↔ Ethereum | ETH/WETH | `OpStandardBridgeAdapter` | **8453:** `0xad3c7f1F26FBF52c9B6a1C02c15F5EBbDF2EaE27` |
| Robinhood ↔ Ethereum | ETH/WETH | `ArbitrumBridgeAdapter` | **4663:** `0xE397b5e27Ae892101435fCB74E6Ed949efD46ef1` (`deployments/bridge-adapters-4663.json`) |
| Robinhood ↔ Ethereum | USDC | CCTP when domain configured; else ETH bridge + swap on Ethereum | Blocked until `ROBINHOOD_USDC` is set |

## Yield adapters (same-chain)

| Chain | Adapter | Address |
|-------|---------|---------|
| Base 8453 | Aave V3 | `0x2D4FaC2d91aE21ace6F24B5B288BC919f4685Dc1` |
| Base 8453 | Compound V3 | `0x5c99A7a1934A95D650c62B639EED2234211a0Ad8` |

Artifacts: `contracts/evm/deployments/adapters-8453.json`, `bridge-adapters-4663.json`.

## On-chain flow

1. Founder sets `NaveTreasury.setLinkedTreasury(destChainId, sisterTreasury)`.
2. Governance passes a Strategy proposal whose payload is `PayloadHash.bridgeHash(adapter, amount, asset, destChainId, destTreasury)`.
3. Agents: `create_bridge_request` → four-agent pipeline → `bridge_outbound` (`NaveExecution.execute`).
4. Destination agents finalize CCTP attestations / L2 messages and deploy to Aave/Compound on Ethereum.

## Env gates

```bash
NAVE_BRIDGE_OUTBOUND_ENABLED=true   # orchestrator + signer create/execute
NAVE_BRIDGE_FINALIZE_ENABLED=true   # destination finalize (CCTP/L2 claim); use bridgeFinalizeGuardrailsOk
```

Finalize is gated in `treasuryBridge.ts` (`bridgeFinalizeGuardrailsOk`). Full CCTP
`receiveMessage` / L2 claim automation still requires an Ethereum sister stack with
live Aave/Compound adapters (Ethereum mainnet factory is not part of the current
Base+RH `USER_CHAINS` cutover — link an existing Eth treasury or deploy Eth DAO
stack via `contracts/evm/script/deploy-eth-sister-stack.sh` once the deploy wallet
holds ≥0.03 ETH on Ethereum).

## Operator gas helpers (not agent path)

Superbridge / Arbitrum Portal remain UX links for human gas — agents use the adapters above.
