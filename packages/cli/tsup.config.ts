// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "tsup";

// Bundle the internal `@inplan/*` workspace packages INTO the CLI output so the published
// `inplan` package has no unpublished `@inplan/*` dependencies. Third-party deps stay
// external (declared in the release package.json, installed by npm at `-g` install time).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  noExternal: [/^@inplan\//],
});
