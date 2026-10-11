#!/usr/bin/env bash
# Live Sepolia / Base Sepolia / Robinhood Testnet / Arc Testnet DAO checklist.
#
# Local Foundry `E2ETest` is NOT a substitute. This script verifies deploy
# artifacts and prints the remaining manual gates (funded keys, Safe handoff,
# app env, agent bind). It does not spend testnet ETH unless --broadcast is set
# on the underlying forge scripts (intentionally off by default).
#
# Usage (from nave-contracts/evm):
#   bash ../scripts/evm-testnet-dao-e2e.sh 11155111
#   bash ../scripts/evm-testnet-dao-e2e.sh 84532
#   bash ../scripts/evm-testnet-dao-e2e.sh 46630
#   bash ../scripts/evm-testnet-dao-e2e.sh 5042002
set -euo pipefail

CHAIN_ID="${1:-}"
if [[ -z "$CHAIN_ID" ]]; then
  echo "Usage: $0 <11155111|84532|46630|5042002>" >&2
  exit 1
fi
if [[ "$CHAIN_ID" != "11155111" && "$CHAIN_ID" != "84532" && "$CHAIN_ID" != "46630" && "$CHAIN_ID" != "5042002" ]]; then
  echo "Chain must be Sepolia (11155111), Base Sepolia (84532), Robinhood Testnet (46630), or Arc Testnet (5042002)." >&2
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

if [[ "$CHAIN_ID" == "5042002" ]]; then
  GAS_STEP="1. Fund founder + 4 agent EOAs + relayer with native USDC (18-decimal gas), not ETH. Treasury USDC is the 6-decimal ERC-20."
else
  GAS_STEP="1. Fund founder + 4 agent EOAs + relayer with testnet ETH."
fi

echo
echo "==> Manual E2E gates (operator)"
cat <<EOF
  ${GAS_STEP}
  2. Deploy the DAO stack (Deploy.s.sol) if deployments/${CHAIN_ID}.json is missing.
     Do not write that file until a real broadcast returns addresses.
  3. Deploy NaveDaoStake with script/DeployTestnetDaoStake.s.sol.
     Owner stays the deployer EOA. Safe handoff is mainnet only.
     Faucet stake default is 100000 base units (0.1 wNAVE). Arc defaults to 0
     until a canonical wNAVE exists.
  4. Live stacks (do not redeploy onto the older protocols):
     Sepolia protocol 0x8D6dFa14Ac28077E3C746C10Fb40C0C424f848D1
     with Aave 0xFfFDfc7DEfbfaF64c232897452Aa6E6F92809426
     and Compound 0x845d8310A861A95Ed1644643D1BAe086944B1AA0.
     Base Sepolia protocol 0xF37271a4A120eD904543bbE648D2f64Fa27b3bC6
     with Aave 0x33D19799EBac88FFDc4e5BF61c199c71963470A6.
     Leave Balancer at 0x0. Robinhood testnet USDC stays 0x0. Arc Aave V3 stays 0x0.
  5. Arc CCTP: DEPLOY_CCTP=true on 5042002 (domain 26 to Sepolia domain 0).
     v2 maxFee 0 can revert if the route charges a fee.
  6. Wire app VITE_EVM_* to the broadcast artifacts for this chain.
  7. Create DAO in the app, then bind agent keys from DaoCreated.
  8. Deposit, govern, and open a strategy only when that adapter address is non-zero.
EOF

echo
echo "Done (checklist only — no on-chain broadcast)."
