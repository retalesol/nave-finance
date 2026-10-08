#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Devnet (Agave 4.1+) requires SBPF v3 artifacts for loader-v3 upgrades.
cargo build-sbf --arch v3 "$@"
