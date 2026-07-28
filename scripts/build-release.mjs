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
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const readPkg = (rel) => JSON.parse(readFileSync(p(rel), "utf8"));

console.log("• Building all workspaces …");
// shell: true — on Windows, npm is npm.cmd, and Node refuses to spawn .cmd/.bat files without a
// shell (EINVAL) regardless of PATH; a bare "npm" also fails (ENOENT — CreateProcess doesn't try
// PATHEXT extensions). Safe here: the argv is a fixed literal, nothing user-controlled is escaped.
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });

const cli = readPkg("packages/cli/package.json");
const appPkg = readPkg("packages/app/package.json");
const cliBundle = p("packages/cli/dist/cli.js");
const appOut = p("packages/app/out");
if (!existsSync(cliBundle)) throw new Error("cli bundle missing — did the cli build run?");
if (!existsSync(`${appOut}/main/index.cjs`)) throw new Error("app build (out/main/index.cjs) missing");

// Derive the third-party runtime deps the published package must declare DIRECTLY from the CLI
// bundle. tsup bundles the internal @inplan/* packages but leaves every third-party import
// external (see packages/cli/tsup.config.ts); each such import must appear in `dependencies` or a
// global install crashes at first run with ERR_MODULE_NOT_FOUND. Deriving — never hand-listing —
// keeps the manifest in lockstep with what the bundle actually imports: a hand-maintained
// allowlist silently dropped `yjs` + `@hocuspocus/provider` in 0.1.20 and broke `npm i -g inplan`.
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
// Leading [^.\w$] rejects member access (`supabase.from("documents")`) and identifiers that merely
// end in from/import/require — only true ESM/require specifier forms are captured.
const IMPORT_FORMS = [
  /(?:^|[^.\w$])from\s*["']([^"']+)["']/g, //         import/export … from "x"
  /(?:^|[^.\w$])import\s*["']([^"']+)["']/g, //       side-effect  import "x"
  /(?:^|[^.\w$])import\s*\(\s*["']([^"']+)["']/g, //  dynamic      import("x")
  /(?:^|[^.\w$])require\s*\(\s*["']([^"']+)["']/g, // require      require("x")
];
const bundleSrc = readFileSync(cliBundle, "utf8");
const externals = new Set();
for (const re of IMPORT_FORMS) {
  let m;
  while ((m = re.exec(bundleSrc))) {
    let spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || BUILTIN.has(spec)) continue; // relative / builtin
    // Reduce a subpath import to its installable package root: `@scope/pkg` or `pkg`.
    spec = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    externals.add(spec);
  }
}

// Resolve each external to a concrete version. Prefer a range a workspace already declares
// (preserves intent for @supabase/supabase-js, ws); otherwise pin the installed version — which
// is exactly what got bundled and tested. Read node_modules/<pkg>/package.json directly so it
// works even when a package's `exports` map hides ./package.json (e.g. @hocuspocus/provider).
const declaredRange = (spec) => cli.dependencies?.[spec] ?? appPkg.dependencies?.[spec];
const installedVersion = (spec) => {
  const pj = p(`node_modules/${spec}/package.json`);
  return existsSync(pj) ? JSON.parse(readFileSync(pj, "utf8")).version : null;
};
// electron is never imported by the bundle (the CLI spawns its binary), so add it explicitly.
const dependencies = { electron: appPkg.devDependencies.electron };
const unresolved = [];
for (const spec of [...externals].sort()) {
  const range = declaredRange(spec) ?? (installedVersion(spec) ? `^${installedVersion(spec)}` : null);
  if (range) dependencies[spec] = range;
  else unresolved.push(spec);
}
if (unresolved.length) {
  throw new Error(
    `Unresolvable CLI-bundle import(s): ${unresolved.join(", ")}. They are external in the bundle ` +
      `but neither declared by a workspace nor installed under node_modules, so the published ` +
      `package would crash with ERR_MODULE_NOT_FOUND. Declare each on the owning @inplan/* package ` +
      `(or packages/cli) and reinstall before releasing.`,
  );
}
console.log(`• Runtime deps derived from bundle: ${Object.keys(dependencies).sort().join(", ")}`);

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
