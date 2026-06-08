import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// Bake the PostHog ingest key into the main bundle ONLY when it's provided at build time
// (the release workflow sets INPLAN_POSTHOG_KEY — a public, write-only key). Without it —
// local/dev/source builds and forks — we leave `process.env.INPLAN_POSTHOG_KEY` as a runtime
// lookup, so a developer's own env still works and forks never ship our key. Telemetry stays
// opt-in regardless; the key only decides whether an opted-in user has an endpoint to hit.
const POSTHOG_KEY = process.env.INPLAN_POSTHOG_KEY;
const mainDefine = POSTHOG_KEY ? { "process.env.INPLAN_POSTHOG_KEY": JSON.stringify(POSTHOG_KEY) } : undefined;

export default defineConfig({
  main: {
    define: mainDefine,
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        // `ws` (bundled transitively via ***REMOVED*** in the local ***REMOVED*** hub) optionally
        // `require()`s these two native addons for fast frame masking. Bundling rewrites that
        // optional require into an empty stub `{}` instead of letting it throw, which defeats
        // ws's pure-JS fallback (it only falls back when the require *throws*) — the result is
        // `bufferUtil.unmask is not a function` on any frame ≥32 bytes, so the hub never syncs.
        // Keep them external: at runtime the require throws MODULE_NOT_FOUND (they aren't
        // installed) and ws uses its JS mask/unmask. Pure JS is plenty for a localhost hub.
        external: ["bufferutil", "utf-8-validate"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
