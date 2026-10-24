import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  define: { global: "globalThis" },
  resolve: {
    alias: {
      "@accumulator/sdk": path.resolve(__dirname, "../sdk/src"),
      // the polyfill plugin injects these into SDK files too, which sit outside this folder
      ...Object.fromEntries(
        ["buffer", "global", "process"].map((s) => [
          `vite-plugin-node-polyfills/shims/${s}`,
          path.resolve(__dirname, `node_modules/vite-plugin-node-polyfills/shims/${s}`),
        ]),
      ),
    },
    // the SDK lives outside this folder; make it use this app's copies
    dedupe: ["@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor"],
  },
  server: { host: "127.0.0.1", port: 5174, fs: { allow: [".."] } },
});
