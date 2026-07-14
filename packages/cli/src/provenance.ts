// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Git provenance for a plan file: the repo short-name + the file's repo-relative
// path. `inplan upload` stamps these onto the cloud document so its locator —
// `/docs/<org>/<repo>/<path>` — mirrors the on-disk source layout, which is what
// lets relative Markdown links resolve identically on disk and on the web.

import { execFileSync } from "node:child_process";
import { basename, dirname, relative, sep } from "node:path";

/** Runs a `git` subcommand in `cwd`, returning trimmed stdout, or null on failure. */
export type GitRunner = (args: string[], cwd: string) => string | null;

const defaultRun: GitRunner = (args, cwd) => {
  try {
    // Discovery must be based purely on `cwd`. Strip any inherited git environment —
    // notably GIT_DIR, which git hooks export — otherwise `rev-parse` would treat an
    // unrelated directory as "inside a work tree" and leak the ambient repo's identity.
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_PARAMETERS"]) delete env[k];
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim();
  } catch {
    return null;
  }
};

/** The repo short-name from a remote URL — the last path segment, sans `.git`.
 *  Handles `git@host:owner/repo.git`, `https://host/owner/repo(.git)`, `ssh://…`. */
export function repoNameFromRemote(url: string): string | null {
  const seg = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop();
  return seg || null;
}

export interface Provenance {
  /** Single-segment repo name (the locator's `<repo>`). */
  repo: string;
  /** The file's path relative to the repo root, POSIX-separated (the `<path>`). */
  path: string;
}

/**
 * Resolve a file's git provenance. Inside a git work tree: `repo` is the origin
 * remote's short-name (or the work-tree dir name when there's no remote), and
 * `path` is the file's root-relative POSIX path. Outside a repo (or with git
 * unavailable): `{ repo: "local", path: basename }`, matching the prior default.
 */
export function gitProvenance(file: string, run: GitRunner = defaultRun): Provenance {
  const dir = dirname(file);
  const root = run(["rev-parse", "--show-toplevel"], dir);
  if (!root) return { repo: "local", path: basename(file) };
  const remote = run(["remote", "get-url", "origin"], dir);
  const repo = (remote && repoNameFromRemote(remote)) || basename(root) || "local";
  const rel = relative(root, file).split(sep).join("/");
  return { repo, path: rel || basename(file) };
}

/**
 * The git author identity configured for `dir` (`git config user.name` / `user.email`).
 * Returns whatever is set (either field may be absent); `null` when `dir` isn't in a
 * git work tree or git is unavailable — so callers can fall through to the next source.
 */
export function gitIdentity(dir: string, run: GitRunner = defaultRun): { name?: string; email?: string } | null {
  // Confirm we're actually inside a work tree first — `git config` would otherwise
  // happily return the user's *global* identity from anywhere on disk.
  if (run(["rev-parse", "--is-inside-work-tree"], dir) !== "true") return null;
  const name = run(["config", "user.name"], dir) || undefined;
  const email = run(["config", "user.email"], dir) || undefined;
  if (!name && !email) return null;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}
