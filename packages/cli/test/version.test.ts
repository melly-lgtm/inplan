// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI derives `--version` from the package.json next to its built bundle (one dir up),
// so a release bumps a single file. These cover that resolution + the fail-soft fallback.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { versionFromDir, versionFromModule } from "../src/version";

const tmps: string[] = [];
/** A throwaway dir holding a package.json with the given `version` field (omit for none). */
function pkgDir(version: unknown, raw?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "inplan-ver-"));
  tmps.push(dir);
  if (raw !== undefined) writeFileSync(join(dir, "package.json"), raw);
  else if (version !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version }));
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // packages/cli
const ownVersion = (JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version: string }).version;

describe("versionFromDir", () => {
  it("reads `version` from <dir>/../package.json (the dir itself need not exist)", () => {
    const base = pkgDir("1.2.3");
    expect(versionFromDir(join(base, "dist"))).toBe("1.2.3"); // dist/../package.json
    expect(versionFromDir(join(base, "bin"))).toBe("1.2.3"); // published layout, same parent
  });

  it("falls back to 0.0.0 when the package.json is missing", () => {
    const base = pkgDir(undefined); // no file written
    expect(versionFromDir(join(base, "dist"))).toBe("0.0.0");
  });

  it("falls back to 0.0.0 when the package.json is malformed JSON", () => {
    const base = pkgDir(undefined, "{ not valid json ");
    expect(versionFromDir(join(base, "dist"))).toBe("0.0.0");
  });

  it("falls back to 0.0.0 when `version` is absent or not a string", () => {
    expect(versionFromDir(join(pkgDir(undefined, JSON.stringify({ name: "x" })), "dist"))).toBe("0.0.0");
    expect(versionFromDir(join(pkgDir(42), "dist"))).toBe("0.0.0");
  });
});

describe("versionFromModule", () => {
  it("resolves the module's directory from a file URL, then reads ../package.json", () => {
    const base = pkgDir("9.9.9");
    mkdirSync(join(base, "bin"), { recursive: true });
    const moduleUrl = pathToFileURL(join(base, "bin", "cli.js")).href;
    expect(versionFromModule(moduleUrl)).toBe("9.9.9");
  });
});

describe("real package layout (no drift)", () => {
  it("resolves this CLI's own version from both the dev (dist) and published (bin) locations", () => {
    // dist/.. and bin/.. both point at packages/cli/package.json — the value the shipped
    // CLI reports. Guards against re-introducing a hard-coded literal that drifts from it.
    expect(versionFromDir(join(CLI_ROOT, "dist"))).toBe(ownVersion);
    expect(versionFromDir(join(CLI_ROOT, "bin"))).toBe(ownVersion);
  });
});
