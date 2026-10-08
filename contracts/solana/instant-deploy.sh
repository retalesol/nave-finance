#!/usr/bin/env bash
# Nave Finance — paste a devnet private key and deploy all programs instantly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RPC_URL="${NAVE_DEVNET_RPC:-https://roseanna-tzdvmq-fast-devnet.helius-rpc.com}"
TEMP_WALLET="$(mktemp "${TMPDIR:-/tmp}/nave-deploy-wallet.XXXXXX")"
trap 'rm -f "$TEMP_WALLET"' EXIT

export PATH="$HOME/.avm/bin:$PATH"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Nave Finance — Instant Devnet Deploy"
echo "═══════════════════════════════════════════════════"
echo ""
echo "RPC: $RPC_URL"
echo ""
echo "Paste your devnet private key below."
echo "  • Base58 secret key (Phantom export / solana-keygen), or"
echo "  • JSON byte array [12,34,...] (64 bytes)"
echo ""
echo -n "Private key: "
read -rs PRIVKEY
echo ""
echo ""

if [[ -z "${PRIVKEY// /}" ]]; then
  echo "❌ No private key provided."
  exit 1
fi

# Ensure node deps for deploy script
if [[ ! -d "$ROOT/../node_modules" ]]; then
  echo "📦 Installing deploy dependencies..."
  (cd "$ROOT/.." && npm install --silent)
fi

node "$ROOT/scripts/parse-keypair.mjs" "$PRIVKEY" "$TEMP_WALLET"

echo "Starting deploy..."
node "$ROOT/scripts/instant-deploy.mjs" \
  --wallet "$TEMP_WALLET" \
  --rpc "$RPC_URL" \
  "$@"

echo ""
echo "🔒 Temporary wallet file deleted."
