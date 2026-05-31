// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node-only: resolves a document's control-channel sidecar locations. These live
// in a CENTRAL per-user store keyed by the document's absolute path — never
// inside the document's own directory — so no repository that uses inplan ever
// has to gitignore runtime state, and control-channel files can't leak into a
// user's project. The CLI and the editor both resolve through here, so they
// always agree on where a document's sidecars are. Imported via `@inplan/core/node`.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Resolved sidecar paths for a plan document, all under a central per-doc dir. */
export interface DocPaths {
  /** Absolute path to the plan document itself. */
  file: string;
  /** The per-document control directory (central store, not in any repo). */
  controlDir: string;
  /** Append-only JSONL control log (wake signal + audit trail). */
  logPath: string;
  /** Last canonical version (diff base for the lost-comment gate; undo base). */
  canonicalPath: string;
  /** Directory holding autosave backups (written by the editor). */
  backupsDir: string;
  /** Proposed agent revision (Review mode), pending human accept/reject. */
  proposedPath: string;
  /** Persisted wait cursor (the seq the agent has consumed). */
  cursorPath: string;
  /** Single-waiter lock: holds the token of the waiter that currently owns this doc. */
  waitLockPath: string;
  /** Append-only record of why each waiter exited (normal / superseded / signal). */
  waitDebugPath: string;
}

/**
 * Root under which every document's sidecars live. Central and outside any repo,
 * so projects never need a `.gitignore` entry for control-channel state. Override
 * with `INPLAN_SIDECAR_DIR`; otherwise it sits under `INPLAN_HOME` (or `~/.inplan`),
 * alongside the global settings file.
 */
export function sidecarRoot(): string {
  if (process.env.INPLAN_SIDECAR_DIR) return process.env.INPLAN_SIDECAR_DIR;
  const home = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(home, "sidecars");
}

/** Nearest ancestor directory that contains a `.git` entry (the repo root), or null. */
function repoRootOf(absFile: string): string | null {
  let dir = dirname(absFile);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Compute the sidecar paths for a plan document. The control dir is keyed by the
 * document's absolute path: a readable label plus a short hash of the full
 * absolute path (the hash is what guarantees uniqueness and stability). The label
 * is `<repoName>-<path-within-repo>` when the document lives in a git repo (e.g.
 * `agent-planner-docs-PLAN.md`, so two docs in one project — even with the same
 * filename in different folders — read distinctly), else `<parentFolder>-<filename>`.
 */
export function docPaths(file: string): DocPaths {
  const abs = resolve(file);
  const root = repoRootOf(abs);
  const raw = root ? `${basename(root)}/${relative(root, abs)}` : `${basename(dirname(abs))}/${basename(abs)}`;
  const label = raw.replace(/[/\\]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `${label}-${createHash("sha1").update(abs).digest("hex").slice(0, 12)}`;
  const controlDir = join(sidecarRoot(), key);
  return {
    file: abs,
    controlDir,
    logPath: join(controlDir, "log.jsonl"),
    canonicalPath: join(controlDir, "canonical.md"),
    backupsDir: join(controlDir, "backups"),
    proposedPath: join(controlDir, "proposed.md"),
    cursorPath: join(controlDir, "cursor"),
    waitLockPath: join(controlDir, "waitlock"),
    waitDebugPath: join(controlDir, "wait-debug.log"),
  };
}
