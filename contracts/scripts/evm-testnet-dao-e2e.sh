#!/usr/bin/env bash
# Live Sepolia / Base Sepolia EVM DAO E2E checklist (operator-run).
#
# Local Foundry `E2ETest` is NOT a substitute. This script verifies deploy
# artifacts and prints the remaining manual gates (funded keys, Safe handoff,
# app env, agent bind). It does not spend testnet ETH unless --broadcast is set
# on the underlying forge scripts (intentionally off by default).
#
# Usage (from nave-contracts/evm):
#   bash ../scripts/evm-testnet-dao-e2e.sh 11155111
#   bash ../scripts/evm-testnet-dao-e2e.sh 84532
set -euo pipefail

CHAIN_ID="${1:-}"
if [[ -z "$CHAIN_ID" ]]; then
  echo "Usage: $0 <11155111|84532>" >&2
  exit 1
fi
if [[ "$CHAIN_ID" != "11155111" && "$CHAIN_ID" != "84532" ]]; then
  echo "Chain must be Sepolia (11155111) or Base Sepolia (84532)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVM="$ROOT/evm"
cd "$EVM"

echo "==> forge build"
forge build >/dev/null

ADAPTERS="deployments/adapters-${CHAIN_ID}.json"
LAUNCH=$(ls -1 deployments/evm-launch-"${CHAIN_ID}".json 2>/dev/null || true)
HARDENED=$(ls -1 deployments/hardened-bridge-"${CHAIN_ID}".json 2>/dev/null || true)

echo "==> Artifacts"
[[ -f "$ADAPTERS" ]] && echo "  adapters: $ADAPTERS" || echo "  adapters: MISSING"
[[ -n "$LAUNCH" ]] && echo "  launch:   $LAUNCH" || echo "  launch:   MISSING (run Deploy / cutover for this chain)"
[[ -n "$HARDENED" ]] && echo "  bridge:   $HARDENED" || echo "  bridge:   (optional for DAO-only E2E)"

if [[ -f "$ADAPTERS" ]]; then
  python3 - <<PY
import json
from pathlib import Path
d = json.loads(Path("$ADAPTERS").read_text())
zeros = [k for k,v in d.items() if isinstance(v,str) and v.startswith("0x") and set(v[2:])=={"0"}]
print("  adapter zeros:", ", ".join(zeros) or "(none)")
print("  note: Balancer stays 0x0 on testnets until a Balancer v2 getRate() pool is validated.")
print("  note: Base Sepolia Compound stays 0x0 until Comet is supplied in NaveAddressRegistry.")
PY
fi

echo
echo "==> Manual E2E gates (operator)"
cat <<EOF
  1. Fund founder + 4 agent EOAs + relayer with testnet ETH.
  2. Deploy/upgrade DAO stack if launch artifact missing:
       npm run mainnet:cutover:evm -- --chain-id ${CHAIN_ID} --scope full ...
  3. Deploy adapters (Aave/Compound when registry singletons are non-zero):
       DEPLOY_AAVE=true DEPLOY_COMPOUND=true forge script script/DeployAdapters.s.sol --rpc-url \$RPC --broadcast
  4. Safe acceptOwnership on protocol/factory (if ownership pending).
  5. Wire app VITE_EVM_* to protocol/factory/RPC for this chain.
  6. Create DAO in app → generate-evm-agent-keys bind from DaoCreated.
  7. Deposit (WETH wrap) → register assets → govern → agent relay → fees.
  8. Strategy leg: only when adapter address is non-zero and constitution-approved.
  9. Fork Balancer pin (mainnet RPC): BALANCER_MIN_BPT_OUT set; defaults to wstETH/WETH MetaStable.
EOF

echo
echo "Done (checklist only — no on-chain broadcast)."
