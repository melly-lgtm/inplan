import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// Bake the PostHog ingest key into the main bundle ONLY when it's provided at build time
// (the release workflow sets INPLAN_POSTHOG_KEY — a public, write-only key). Without it —
// local/dev/source builds and forks — we leave `process.env.INPLAN_POSTHOG_KEY` as a runtime
// lookup, so a developer's own env still works and forks never ship our key. Telemetry stays
// opt-in regardless; the key only decides whether an opted-in user has an endpoint to hit.
// Same build-time bake for the live-collab signing PUBLIC key (INPLAN_COLLAB_PUBLIC_KEY): the
// main process verifies the entitlement lease + the fetched plugin bundle against it. Public, so
// safe to ship; absent ⇒ a runtime env lookup (dev) and otherwise turn-only (fail-closed).
const POSTHOG_KEY = process.env.INPLAN_POSTHOG_KEY;
const COLLAB_PUBLIC_KEY = process.env.INPLAN_COLLAB_PUBLIC_KEY;
const mainDefine = {
  ...(POSTHOG_KEY ? { "process.env.INPLAN_POSTHOG_KEY": JSON.stringify(POSTHOG_KEY) } : {}),
  ...(COLLAB_PUBLIC_KEY ? { "process.env.INPLAN_COLLAB_PUBLIC_KEY": JSON.stringify(COLLAB_PUBLIC_KEY) } : {}),
};

export default defineConfig({
  main: {
    define: mainDefine,
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
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
