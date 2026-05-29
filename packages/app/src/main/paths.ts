// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename, dirname, join } from "node:path";

export interface DocPaths {
  file: string;
  controlDir: string;
  logPath: string;
  canonicalPath: string;
  backupsDir: string;
  proposedPath: string;
}

/** Sidecar paths for a plan document, under a `.agent-planner/` sibling dir. */
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
  };
}
