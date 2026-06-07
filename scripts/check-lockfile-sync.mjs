// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fail if any workspace package.json version has drifted from its package-lock.json entry.
// `npm ci` TOLERATES a workspace self-version mismatch, so it never caught the lockfile going
// stale (packages/cli was stuck at 0.1.6 while the manifest moved to 0.1.10, shipped across
// several releases). This guards that exact drift in CI (and can be run locally). The fix when
// it fires: bump with `npm version … -w <pkg> --no-git-tag-version` (updates both), or run
// `npm install --package-lock-only`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lock = readJson(`${root}/package-lock.json`);

let drift = false;
for (const dir of readdirSync(`${root}/packages`)) {
  const manifest = `${root}/packages/${dir}/package.json`;
  if (!existsSync(manifest)) continue;
  const manifestVersion = readJson(manifest).version;
  const lockVersion = lock.packages?.[`packages/${dir}`]?.version;
  if (manifestVersion !== lockVersion) {
    console.error(`✗ packages/${dir}: package.json ${manifestVersion} ≠ package-lock ${lockVersion}`);
    drift = true;
  }
}

if (drift) {
  console.error("\nLockfile is stale. Fix: npm install --package-lock-only  (then commit package-lock.json)");
  process.exit(1);
}
console.log("✓ package-lock workspace versions are in sync");
