#!/bin/sh
# NAVE_DISABLE_WORKER=true runs the HTTP signer only (e.g. a testnet signer that
# must not duplicate another service's leased worker loops).
if [ "$NAVE_DISABLE_WORKER" != "true" ]; then
  NAVE_WORKER_PROCESS=1 npx tsx src/worker.ts &
fi
exec npx tsx src/index.ts
