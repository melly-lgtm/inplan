// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Assemble the publishable `inplan` package — the single global install that delivers
// BOTH the CLI and the Electron editor. Layout:
//   release/bin/cli.js   ← @inplan/cli bundle (internal @inplan/* bundled in; third-party external)
//   release/app/         ← @inplan/app electron-vite output (main + preload + renderer)
//   release/package.json ← name "inplan", bin, + runtime deps (electron + the CLI's third-party)
// `npm i -g inplan` then gives `inplan` (CLI) which launches the bundled app via its
// electron dependency (see resolveBundledApp in cli.ts); `inplan update` self-updates via npm.
//
// Usage:  node scripts/build-release.mjs   (from the inplan repo root). Then: cd release && npm publish

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const readPkg = (rel) => JSON.parse(readFileSync(p(rel), "utf8"));

console.log("• Building all workspaces …");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

const cli = readPkg("packages/cli/package.json");
const appPkg = readPkg("packages/app/package.json");
const cliBundle = p("packages/cli/dist/cli.js");
const appOut = p("packages/app/out");
if (!existsSync(cliBundle)) throw new Error("cli bundle missing — did the cli build run?");
if (!existsSync(`${appOut}/main/index.js`)) throw new Error("app build (out/main/index.js) missing");

// The CLI bundle externalizes these (its @inplan/* deps are bundled in); the published
// package must declare them + electron so a global install resolves them.
const RUNTIME = ["***REMOVED***", "@supabase/supabase-js", "ws", ***REMOVED***];
const dependencies = { electron: appPkg.devDependencies.electron };
for (const d of RUNTIME) dependencies[d] = cli.dependencies[d];

console.log("• Assembling release/ …");
const rel = p("release");
rmSync(rel, { recursive: true, force: true });
mkdirSync(`${rel}/bin`, { recursive: true });
cpSync(cliBundle, `${rel}/bin/cli.js`);
// Ensure the shebang (npm relies on it for the symlinked `inplan` executable) + exec bit.
let bin = readFileSync(`${rel}/bin/cli.js`, "utf8");
if (!bin.startsWith("#!")) bin = `#!/usr/bin/env node\n${bin}`;
writeFileSync(`${rel}/bin/cli.js`, bin);
chmodSync(`${rel}/bin/cli.js`, 0o755);
cpSync(appOut, `${rel}/app`, { recursive: true });
// Ship the skill so a global install can offer it to AI agents (npm→skill bootstrap).
mkdirSync(`${rel}/skill`, { recursive: true });
cpSync(p("skill/SKILL.md"), `${rel}/skill/SKILL.md`);
cpSync(p("LICENSE"), `${rel}/LICENSE`);

writeFileSync(
  `${rel}/package.json`,
  JSON.stringify(
    {
      name: "inplan",
      version: cli.version,
      description: "inplan — a Markdown editor for human ⇄ coding-agent planning. CLI + desktop editor.",
      license: "AGPL-3.0-or-later",
      // Required for npm provenance (--provenance): the URL must match the GitHub repo the
      // trusted-publishing workflow runs in, or publish fails with E422.
      repository: { type: "git", url: "git+https://github.com/melly-lgtm/inplan.git" },
      homepage: "https://inplan.ai",
      type: "module",
      bin: { inplan: "bin/cli.js" },
      files: ["bin", "app", "skill", "LICENSE"],
      engines: { node: ">=22" },
      // npm→skill bootstrap: offer the skill to AI agents already on the machine. Guard-
      // railed in `install-skill` (opt-out, idempotent, agent-must-exist) and `|| true` so a
      // global install never fails over it. Skipped under `npm install --ignore-scripts`
      // (then `inplan install-skill` is the manual path).
      scripts: { postinstall: "node bin/cli.js install-skill --quiet || true" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

console.log(`✓ release/ assembled — inplan@${cli.version}`);
console.log("  Publish with:  (cd release && npm publish)   [needs `npm login`]");
console.log("  Dry run:       (cd release && npm pack --dry-run)");
