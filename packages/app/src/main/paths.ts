// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename, dirname, join } from "node:path";

export interface DocPaths {
  file: string;
  controlDir: string;
  logPath: string;
  canonicalPath: string;
  backupsDir: string;
  proposedPath: string;
  /** Persisted wait cursor (owned by the CLI; present here so the shared
   *  ControlChannel can be constructed from these paths). */
  cursorPath: string;
  /** Single-waiter lock token file (owned by the CLI). */
  waitLockPath: string;
}

/** Sidecar paths for a plan document, under a `.inplan/` sibling dir. */
export function docPaths(file: string): DocPaths {
  const dir = dirname(file);
  const base = basename(file);
  const controlDir = join(dir, ".inplan");
  return {
    file,
    controlDir,
    logPath: join(controlDir, `${base}.log.jsonl`),
    canonicalPath: join(controlDir, `${base}.canonical.md`),
    backupsDir: join(controlDir, `${base}.backups`),
    proposedPath: join(controlDir, `${base}.proposed.md`),
    cursorPath: join(controlDir, `${base}.cursor`),
    waitLockPath: join(controlDir, `${base}.waitlock`),
  };
}
