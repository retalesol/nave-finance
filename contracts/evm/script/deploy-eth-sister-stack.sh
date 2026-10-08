#!/usr/bin/env bash
# Deploy Nave DAO core + Aave/Compound adapters on Ethereum mainnet (chain 1).
# Required for RH→Eth sister treasuries and post-bridge yield.
#
# Prerequisites:
#   - EVM_DEPLOY_PRIVATE_KEY funded with ≥0.03 ETH on Ethereum (gas buffer)
#   - EVM_ETHEREUM_RPC_URL
#   - PROTOCOL_OWNER, PROTOCOL_TREASURY, PYTH_ADDRESS (Ethereum Pyth)
#
# Usage (from evm/):
#   set -a && source /path/to/.env.cutover.base-rh && set +a
#   export EVM_ETHEREUM_RPC_URL=...
#   export PYTH_ADDRESS=0x4305FB66699C3B2702D4d05CF36551390A48cE00  # verify on-chain
#   bash script/deploy-eth-sister-stack.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# deployments/1.json is the Anvil fixture (dao stack undeployed). If it is still
# the on-disk artifact, refuse before any RPC or forge broadcast. A real deploy
# archives that file first (do not delete the history) and lets Deploy.s.sol
# write a new 1.json. A missing file is not treated as production.
if [[ -f deployments/1.json ]]; then
  node script/lib/deploymentArtifactStatus.mjs deployments/1.json
fi

RPC="${EVM_ETHEREUM_RPC_URL:?set EVM_ETHEREUM_RPC_URL}"
KEY="${EVM_DEPLOY_PRIVATE_KEY:?set EVM_DEPLOY_PRIVATE_KEY}"
: "${PROTOCOL_OWNER:?set PROTOCOL_OWNER}"
: "${PROTOCOL_TREASURY:?set PROTOCOL_TREASURY}"
: "${PYTH_ADDRESS:?set PYTH_ADDRESS for Ethereum}"

DEPLOYER=$(cast wallet address --private-key "$KEY")
BAL_WEI=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
MIN_WEI=30000000000000000 # 0.03 ETH
echo "deployer=$DEPLOYER balance_wei=$BAL_WEI"
if [[ "$BAL_WEI" -lt "$MIN_WEI" ]]; then
  echo "ERROR: need ≥0.03 ETH on Ethereum for Deploy.s.sol + adapters (have $BAL_WEI wei)." >&2
  echo "Fund $DEPLOYER (or Safe→deployer), then re-run." >&2
  exit 1
fi

echo "== Deploy DAO stack (chain 1) =="
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" \
  --private-key "$KEY" \
  --broadcast -vv

# A real deploy must have replaced the Anvil fixture. Refuse again before adapters.
if [[ ! -f deployments/1.json ]]; then
  echo "ERROR: Deploy.s.sol did not write deployments/1.json." >&2
  exit 1
fi
node script/lib/deploymentArtifactStatus.mjs deployments/1.json
PROTOCOL=$(python3 -c "import json; print(json.load(open('deployments/1.json'))['protocol'])")
echo "protocol=$PROTOCOL"

echo "== Deploy Aave + Compound adapters =="
NAVE_PROTOCOL="$PROTOCOL" DEPLOY_AAVE=true DEPLOY_COMPOUND=true DEPLOY_BALANCER=false \
  forge script script/DeployAdapters.s.sol:DeployAdapters \
  --rpc-url "$RPC" \
  --private-key "$KEY" \
  --broadcast -vv

echo "== Done. Wire app env from deployments/1.json + adapters-1.json =="
python3 - <<'PY'
import json
d=json.load(open("deployments/1.json"))
a=json.load(open("deployments/adapters-1.json"))
print(f"VITE_EVM_ETHEREUM_PROTOCOL_ADDRESS={d['protocol']}")
print(f"VITE_EVM_ETHEREUM_FACTORY_ADDRESS={d['factory']}")
print(f"VITE_EVM_ETHEREUM_AAVE_ADAPTER_ADDRESS={a.get('aaveV3Adapter','')}")
print(f"VITE_EVM_ETHEREUM_COMPOUND_ADAPTER_ADDRESS={a.get('compoundV3Adapter','')}")
PY
