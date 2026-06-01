// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { gitProvenance, repoNameFromRemote, type GitRunner } from "../src/provenance";

describe("repoNameFromRemote", () => {
  it("extracts the short-name from SSH, HTTPS, and trailing-slash URLs", () => {
    expect(repoNameFromRemote("git@github.com:melly-lgtm/inplan.git")).toBe("inplan");
    expect(repoNameFromRemote("https://github.com/melly-lgtm/inplan.git")).toBe("inplan");
    expect(repoNameFromRemote("https://github.com/melly-lgtm/inplan")).toBe("inplan");
    expect(repoNameFromRemote("ssh://git@host.xz:22/group/sub/proj.git")).toBe("proj");
    expect(repoNameFromRemote("https://github.com/o/repo/")).toBe("repo");
  });
  it("returns null for an empty url", () => {
    expect(repoNameFromRemote("")).toBeNull();
  });
});

/** A GitRunner stubbed from a fixed top-level + optional remote. */
function fakeGit(root: string | null, remote: string | null): GitRunner {
  return (args) => {
    if (args[0] === "rev-parse") return root;
    if (args[0] === "remote") return remote;
    return null;
  };
}

describe("gitProvenance", () => {
  it("derives repo (from origin) + repo-relative POSIX path inside a work tree", () => {
    const run = fakeGit("/Users/me/code/inplan", "git@github.com:melly-lgtm/inplan.git");
    expect(gitProvenance("/Users/me/code/inplan/docs/PLAN.md", run)).toEqual({ repo: "inplan", path: "docs/PLAN.md" });
  });

  it("falls back to the work-tree dir name when there is no remote", () => {
    const run = fakeGit("/Users/me/code/my-plans", null);
    expect(gitProvenance("/Users/me/code/my-plans/PLAN.md", run)).toEqual({ repo: "my-plans", path: "PLAN.md" });
  });

  it("falls back to {local, basename} outside a git repo", () => {
    const run = fakeGit(null, null);
    expect(gitProvenance("/tmp/scratch/notes.md", run)).toEqual({ repo: "local", path: "notes.md" });
  });

  it("handles a file at the repo root", () => {
    const run = fakeGit("/r/proj", "https://github.com/o/proj.git");
    expect(gitProvenance("/r/proj/PLAN.md", run)).toEqual({ repo: "proj", path: "PLAN.md" });
  });
});
