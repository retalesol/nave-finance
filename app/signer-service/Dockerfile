# Nave signer service — minimal Node container.
# Node 22: ships a native global WebSocket (required by rpc-websockets@9, pulled
# in by @solana/web3.js ^1.95 for confirmTransaction subscriptions). Node 20 has
# no global WebSocket and throws at sign time.
FROM node:22-slim

WORKDIR /app

# Install runtime dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source + vendored IDLs.
COPY tsconfig.json ./
COPY src ./src
COPY idl ./idl

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Run the TypeScript entrypoint directly via tsx (a runtime dependency).
# The HTTP relayer (index.ts) and the background worker (worker.ts — staking
# mirror + bridge watcher + agent loops) share one container; the worker's
# money-moving ticks are cross-replica leased so multiple replicas stay safe.
CMD ["sh", "-c", "npx tsx src/worker.ts & exec npx tsx src/index.ts"]
