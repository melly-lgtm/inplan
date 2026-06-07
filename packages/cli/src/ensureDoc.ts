// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan open <path>` on a not-yet-existing path creates an empty plan doc, so the agent can
// open the editor first and fill the document in live — no separate "write the file" step. Never
// clobbers an existing file. Kept in its own module so it's unit-testable (cli.ts runs main() on
// import).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Create `file` as an empty document (and its parent dir) if it doesn't exist yet. Returns true
 *  if it created the file, false if it was already there. */
export function ensureDocFile(file: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  return true;
}
