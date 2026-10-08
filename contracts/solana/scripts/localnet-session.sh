#!/usr/bin/env bash
# Start or reuse localnet validator and deploy Nave programs once per session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
VALIDATOR_LOG="${ROOT}/.test-runs/validator.log"
PID_FILE="${ROOT}/.test-runs/validator.pid"

mkdir -p "${ROOT}/.test-runs"

health() {
  curl -sf -X POST "$RPC" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null 2>&1
}

start_validator() {
  if health; then
    echo "Localnet already running at $RPC"
    return
  fi

  echo "Starting solana-test-validator (log: .test-runs/validator.log)..."
  solana-test-validator --reset >"$VALIDATOR_LOG" 2>&1 &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 60); do
    if health; then
      echo "Localnet ready."
      return
    fi
    sleep 1
  done

  echo "Validator failed to start. See $VALIDATOR_LOG"
  exit 1
}

deploy_programs() {
  export ANCHOR_PROVIDER_URL="$RPC"
  export ANCHOR_WALLET="$WALLET"

  if [[ -x "$HOME/.avm/bin/anchor-0.32.1" ]]; then
    ANCHOR_BIN="$HOME/.avm/bin/anchor-0.32.1"
  elif command -v anchor >/dev/null 2>&1; then
    ANCHOR_BIN="anchor"
  else
    echo "anchor CLI not found (install avm use 0.32.1)"
    exit 1
  fi

  echo "Building programs..."
  "$ANCHOR_BIN" build

  echo "Deploying to localnet..."
  "$ANCHOR_BIN" deploy --provider.cluster localnet

  if [[ -d target/idl ]]; then
    cp target/idl/*.json idl/ 2>/dev/null || true
  fi

  echo "Deploy complete."
}

case "${1:-up}" in
  up)
    start_validator
    deploy_programs
    echo ""
    echo "Localnet session ready. Run checkpoint tests with:"
    echo "  npm run test:manifest"
    echo "  npm run test:checkpoint"
    ;;
  status)
    if health; then echo "Localnet: up ($RPC)"; else echo "Localnet: down"; fi
    ;;
  down)
    if [[ -f "$PID_FILE" ]]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    lsof -ti:8899 | xargs kill -9 2>/dev/null || true
    echo "Localnet stopped."
    ;;
  *)
    echo "Usage: $0 [up|status|down]"
    exit 1
    ;;
esac
