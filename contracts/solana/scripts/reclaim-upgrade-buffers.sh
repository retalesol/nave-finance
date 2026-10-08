#!/usr/bin/env bash
# Reclaim rent from dangling BPF upgrade *buffer* accounts (not programs).
#
# During `solana program deploy`, the CLI creates a buffer account that holds
# the ELF + rent. If a deploy is interrupted, retried, or races, old buffers can
# remain and lock large amounts of SOL until closed. Closing a buffer returns
# lamports to your wallet and does NOT touch deployed programs.
#
# Usage (from solana/):
#   bash scripts/reclaim-upgrade-buffers.sh [RPC_URL] [KEYPAIR_PATH]
#
# Defaults: devnet public RPC + .deploy-wallet-devnet.json
#
# Safe bulk close (only buffer accounts owned by this authority):
#   bash scripts/reclaim-upgrade-buffers.sh --close-all [RPC_URL] [KEYPAIR_PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CLOSE_ALL=false
if [[ "${1:-}" == "--close-all" ]]; then
  CLOSE_ALL=true
  shift
fi

RPC="${1:-https://api.devnet.solana.com}"
KP="${2:-.deploy-wallet-devnet.json}"

if [[ ! -f "$KP" ]]; then
  echo "Keypair not found: $KP" >&2
  exit 1
fi

AUTH="$(solana address -k "$KP")"
echo "Authority: $AUTH"
echo "RPC:       $RPC"
echo ""

echo "=== Buffer accounts (upgrade deploy leftovers) ==="
solana program show --buffers -u "$RPC" -k "$KP" --lamports || true
echo ""

if $CLOSE_ALL; then
  echo "Closing all buffer accounts for this authority (programs are NOT closed)…"
  solana program close --buffers -u "$RPC" -k "$KP"
  echo ""
  echo "=== Remaining buffers ==="
  solana program show --buffers -u "$RPC" -k "$KP" --lamports || true
  echo ""
  echo "Wallet balance:"
  solana balance -u "$RPC" -k "$KP"
else
  echo "To reclaim rent from every dangling buffer in one shot:"
  echo "  bash scripts/reclaim-upgrade-buffers.sh --close-all \"$RPC\" \"$KP\""
  echo ""
  echo "To close one buffer by address (after verifying it is a Buffer, not a Program):"
  echo "  solana program show <ADDRESS> -u \"$RPC\""
  echo "  solana program close <ADDRESS> -u \"$RPC\" -k \"$KP\""
fi
