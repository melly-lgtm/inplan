// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Single source of truth for the CLI version: the package.json adjacent to the built bundle,
// so a release bumps one place. The bundle sits one directory below its package.json in both
// layouts — dev `dist/cli.js → ../package.json` (@inplan/cli) and the published
// `bin/cli.js → ../package.json` (the generated `inplan` pkg, whose version build-release.mjs
// sets to the CLI's) — so `<moduleDir>/../package.json` is always the right file.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read `version` from `<moduleDir>/../package.json`. Falls back to "0.0.0" if the file is
 *  missing, unparseable, or has no string `version`. */
export function versionFromDir(moduleDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** As {@link versionFromDir}, resolving the directory from a module URL (pass `import.meta.url`). */
export function versionFromModule(moduleUrl: string): string {
  return versionFromDir(dirname(fileURLToPath(moduleUrl)));
}
