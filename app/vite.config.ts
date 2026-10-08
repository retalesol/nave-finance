import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import componentTagger from "./plugins/component-tagger";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (mode === "production" && env.VITE_USE_MOCKS === "true") {
    throw new Error("Refusing production build: VITE_USE_MOCKS=true. Unset it before building.");
  }
  return ({
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    hmr: {
      overlay: false,
      timeout: 15000,
    },
    watch: {
      usePolling: true,
      interval: 500,
      binaryInterval: 500,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
    // Force a single physical copy of React/React-DOM. Some transitive deps
    // (e.g. @tanstack/react-query) can be symlinked into a nested node_modules
    // — notably under Deno-managed installs (.deno/…) — which otherwise pulls
    // in a second React instance and triggers "Invalid hook call / cannot read
    // 'useEffect' of null" at QueryClientProvider. Deduping keeps one React.
    dedupe: ["react", "react-dom"],
  },
  build: {
    // The default 500kb warning is noisy for a wallet-heavy Web3 app — several
    // vendor dependencies (Solana web3.js, wagmi/viem, WalletConnect/Reown,
    // Three.js for the Dither background effect) are legitimately large and
    // already isolated into their own chunks below. Raise the budget to an
    // intentional threshold rather than leaving the default warning
    // unaddressed on every build.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // Group by the heaviest, most stable vendor dependencies so they
          // cache independently of app code and of each other — a change to
          // app code no longer invalidates the wallet/3D vendor chunks, and
          // vice versa.
          if (id.includes("three") || id.includes("@react-three") || id.includes("postprocessing")) {
            return "vendor-three"; // Dither's WebGL stack
          }
          if (id.includes("@solana/") || id.includes("@coral-xyz")) {
            return "vendor-solana";
          }
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("react-router")) {
            return "vendor-react";
          }
          // Deliberately NOT grouping the EVM wallet ecosystem (wagmi/viem/
          // Reown/WalletConnect/Coinbase/Safe) into one bucket: that combined
          // many independently-sized chunks Rollup already splits well on its
          // own into a single ~4MB blob, which is worse for caching than the
          // default per-entry chunking. Let Rollup's default heuristics handle
          // it instead of forcing a coarser grouping.
          return undefined;
        },
      },
    },
  },
  });
});
