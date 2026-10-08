# Nave EVM indexer — minimal Node container.
FROM node:22-slim

WORKDIR /app

# Install runtime dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source.
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# Run the TypeScript entrypoint directly via tsx (a runtime dependency).
CMD ["npx", "tsx", "src/index.ts"]
