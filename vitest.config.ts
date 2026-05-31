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
  },
});
