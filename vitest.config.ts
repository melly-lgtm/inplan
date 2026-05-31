import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@inplan/core/node": fileURLToPath(new URL("./packages/core/src/node.ts", import.meta.url)),
      "@inplan/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Component tests are .test.tsx and opt into a DOM per-file (`// @vitest-environment happy-dom`).
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.d.ts",
        // Pure type/interface declarations — no executable statements to cover.
        "packages/app/src/shared/api.ts",
        "packages/core/src/channel.ts",
        // Need a real runtime the harness can't provide:
        //  - Electron main process + preload bridge (Playwright _electron smoke covers these),
        //  - the renderer entry, and the CodeMirror editor (real layout APIs).
        "packages/app/src/main/**",
        "packages/app/src/preload/**",
        "packages/app/src/renderer/main.tsx",
        "packages/app/src/renderer/SourceEditor.tsx",
        // Binary entry: runs main() on import + forks Electron / calls process.exit,
        // so it can't be imported in-process. Its logic units (gate, wait, paths,
        // editorProcess) are unit-tested and the orchestration is smoke-tested;
        // covering waitCycle itself needs a logic-extraction refactor (tracked).
        "packages/cli/src/cli.ts",
      ],
      reporter: ["text-summary", "text"],
    },
  },
});
