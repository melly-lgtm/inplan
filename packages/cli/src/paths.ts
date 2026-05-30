// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename, dirname, join } from "node:path";

/** Resolved sidecar paths for a plan document, all under a `.agent-planner/` sibling dir. */
export interface DocPaths {
  /** Absolute-ish path to the plan document itself. */
  file: string;
  /** The `.agent-planner/` control directory next to the file. */
  controlDir: string;
  /** Append-only JSONL control log (wake signal + audit trail). */
  logPath: string;
  /** Last canonical version (diff base for the lost-comment gate; undo base). */
  canonicalPath: string;
  /** Directory holding autosave backups (written by the editor). */
  backupsDir: string;
  /** Proposed agent revision (Review mode), pending human accept/reject. */
  proposedPath: string;
  /** Persisted wait cursor (the seq the agent has consumed) — so the agent never hand-manages it. */
  cursorPath: string;
}

/** Compute the sidecar paths for a plan document. */
export function docPaths(file: string): DocPaths {
  const dir = dirname(file);
  const base = basename(file);
  const controlDir = join(dir, ".agent-planner");
  return {
    file,
    controlDir,
    logPath: join(controlDir, `${base}.log.jsonl`),
    canonicalPath: join(controlDir, `${base}.canonical.md`),
    backupsDir: join(controlDir, `${base}.backups`),
    proposedPath: join(controlDir, `${base}.proposed.md`),
    cursorPath: join(controlDir, `${base}.cursor`),
  };
}
