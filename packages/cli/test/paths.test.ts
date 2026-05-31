// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docPaths } from "../src/paths";

describe("docPaths", () => {
  const ROOT = "/tmp/inplan-test-sidecars";
  beforeEach(() => {
    process.env.INPLAN_SIDECAR_DIR = ROOT;
  });
  afterEach(() => {
    delete process.env.INPLAN_SIDECAR_DIR;
  });

  it("places sidecars in a central per-document dir, not next to the file (no repo → parentFolder-filename)", () => {
    const p = docPaths("/work/project/design.plan.md");
    expect(p.file).toBe("/work/project/design.plan.md");
    // Not inside a git repo, so the label falls back to <parentFolder>-<filename>.
    expect(p.controlDir).toMatch(new RegExp(`^${ROOT}/project-design\\.plan\\.md-[0-9a-f]{12}$`));
    expect(p.logPath).toBe(join(p.controlDir, "log.jsonl"));
    expect(p.canonicalPath).toBe(join(p.controlDir, "canonical.md"));
    expect(p.proposedPath).toBe(join(p.controlDir, "proposed.md"));
    expect(p.backupsDir).toBe(join(p.controlDir, "backups"));
    expect(p.cursorPath).toBe(join(p.controlDir, "cursor"));
    expect(p.waitLockPath).toBe(join(p.controlDir, "waitlock"));
    // The control dir lives outside the document's own directory — so no repo
    // that uses inplan ever needs to gitignore control-channel state.
    expect(p.controlDir.startsWith("/work/project")).toBe(false);
  });

  it("is stable for the same path and distinct for same-named files in different dirs", () => {
    expect(docPaths("/a/x.plan.md").controlDir).toBe(docPaths("/a/x.plan.md").controlDir);
    expect(docPaths("/a/x.plan.md").controlDir).not.toBe(docPaths("/b/x.plan.md").controlDir);
  });

  it("labels with the repo name + in-repo path when the document is inside a git repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "inplan-repo-"));
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "docs"));
      const p = docPaths(join(repo, "docs", "PLAN.md"));
      const dir = basename(p.controlDir);
      // <repoName>-<path-within-repo> — includes the in-repo folders.
      expect(dir.startsWith(`${basename(repo)}-docs-PLAN.md-`)).toBe(true);
      expect(dir).toMatch(/-[0-9a-f]{12}$/);

      // A second doc in the same repo gets a distinct label (path included).
      const q = docPaths(join(repo, "docs", "DESIGN.md"));
      expect(basename(q.controlDir).startsWith(`${basename(repo)}-docs-DESIGN.md-`)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
