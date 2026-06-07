// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan open <path>` on a not-yet-existing path creates an empty plan doc, so the agent can
// open the editor first and fill the document in live — no separate "write the file" step. Never
// clobbers an existing file. Kept in its own module so it's unit-testable (cli.ts runs main() on
// import).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Create `file` as an empty document (and its parent dir) if it doesn't exist yet. Returns true
 *  if it created the file, false if it was already there. The create is **atomic** (`wx` flag —
 *  exclusive create) so racing `open` calls can never truncate a file that appeared in between:
 *  the non-clobber guarantee holds even under concurrency. */
export function ensureDocFile(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // already there → leave it untouched
    throw err;
  }
}
