// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDocFile } from "../src/ensureDoc";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inplan-ensure-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureDocFile", () => {
  it("creates an empty doc (and parent dirs) for a fresh path", () => {
    const f = join(dir, "nested", "my-plan.plan.md");
    expect(ensureDocFile(f)).toBe(true);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("");
  });

  it("never clobbers an existing file", () => {
    const f = join(dir, "existing.plan.md");
    writeFileSync(f, "# Keep me\n");
    expect(ensureDocFile(f)).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("# Keep me\n");
  });
});
