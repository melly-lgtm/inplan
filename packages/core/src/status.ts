// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A document's *location* state: a plan moves between local (files on disk, the
// desktop app, a local agent) and cloud (a Supabase `documents` row, shared and
// live-collaborative) over its life. The CLI's `open`/`wait`/`signal` loop
// **follows** the doc by injecting the backend its status names; the desktop app
// flips the status on promote (Collaborate on Cloud) / demote (Save locally).
//
// The status lives beside the other sidecars in the central per-user store
// (`~/.inplan/sidecars/<key>/status.json`), keyed by the document's *original*
// absolute path — never in the repo, same rule as the control log. There is no
// agent-attachment flag here: who is driving the doc is derived from live
// presence, not persisted (see docs/PLAN.md § Local ⇄ cloud session handoff).
//
// fs-backed: import from `@inplan/core/node`, never the browser root.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where a document currently lives. */
export type DocLocation = "local" | "cloud";

/** The path-locator that addresses a cloud doc (mirrors the URL `/docs/<org>/<repo>/<path>`). */
export interface CloudLocator {
  org: string;
  repo: string;
  path: string;
}

export interface DocStatus {
  /** `local` (the default) or `cloud`. */
  location: DocLocation;
  /** The `documents.id` this local file is promoted to (set iff `location === "cloud"`). */
  cloudDocId?: string;
  /** Human-readable cloud address, for links/UX (optional; the id is authoritative). */
  cloudLocator?: CloudLocator;
  /** The on-disk path the doc was promoted from / should be demoted back to. */
  originalPath?: string;
  /** Hash of the file body at the last local⇄cloud sync, so a reconcile-on-open
   *  can tell a freshly downloaded / locally-edited file from an in-sync one. */
  lastSyncedHash?: string;
}

/** A brand-new / never-promoted document is local. */
export const DEFAULT_STATUS: DocStatus = { location: "local" };

/** Content hash used for reconcile comparisons (stable across platforms). */
export function hashBody(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read a document's status, or the local default when absent/corrupt. */
export function readStatus(statusPath: string): DocStatus {
  if (!existsSync(statusPath)) return { ...DEFAULT_STATUS };
  try {
    const raw = JSON.parse(readFileSync(statusPath, "utf8")) as Partial<DocStatus>;
    if (raw.location !== "local" && raw.location !== "cloud") return { ...DEFAULT_STATUS };
    // A cloud status without a doc id is meaningless — treat it as local.
    if (raw.location === "cloud" && typeof raw.cloudDocId !== "string") return { ...DEFAULT_STATUS };
    return { ...DEFAULT_STATUS, ...raw, location: raw.location };
  } catch {
    return { ...DEFAULT_STATUS };
  }
}

/** Persist a document's status (creates the sidecar dir if needed). */
export function writeStatus(statusPath: string, status: DocStatus): void {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
}
