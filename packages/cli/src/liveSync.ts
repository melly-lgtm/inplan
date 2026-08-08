// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure decision helpers for the live-collab working-copy sync. The tricky question — "when is it
// safe to overwrite the agent's local working copy with a freshly probed hub canonical?" — is kept
// side-effect-free here so it can be unit-tested without a live hub, then driven from `runRemote`.

export interface HydrateInput {
  /** Does the working copy already exist on disk? */
  exists: boolean;
  /** Is a local fallback edit pending — i.e. a prior turn applied an edit locally because the hub
   *  was unreachable, and it hasn't been pushed yet? */
  pending: boolean;
  /** Hash of the working copy's current content (null if it doesn't exist). */
  currentHash: string | null;
  /** Hash recorded the last time WE wrote/synced the working copy (null if never). */
  syncedHash: string | null;
}

/**
 * Decide whether to (re)hydrate the working copy from a freshly probed hub canonical at turn START.
 *  - No file yet ⇒ seed it (true).
 *  - A pending local fallback edit ⇒ keep it, never overwrite (false) — it must be pushed first.
 *  - Otherwise overwrite ONLY when the agent hasn't touched the copy since our last write/sync (its
 *    hash still matches the recorded synced hash). A mismatch means unsynced agent edits to preserve.
 *
 * This is what lets a FAILED end-of-turn re-sync self-heal: on that path the working copy is left
 * equal to what was applied to the hub (so its hash still matches the synced hash), and the next
 * run safely hydrates it — pulling in the human's edits instead of reverting them.
 */
export function shouldHydrateWorkFile(o: HydrateInput): boolean {
  if (!o.exists) return true;
  if (o.pending) return false;
  return o.currentHash != null && o.currentHash === o.syncedHash;
}

/**
 * Whether a hub failure during the turn left a local revision that must be replayed to the hub later
 * — i.e. whether to mark the working copy `.pending`. ONLY a WRITE failure qualifies: the accepted
 * edit was persisted locally and hasn't reached the hub. A READ failure alone must NOT: the agent may
 * have made no edit, and a spurious `.pending` would skip hydration on the next healthy run and risk
 * applying a stale copy back over newer hub edits. (The synced-hash check preserves any genuine local
 * edit on the read path anyway, since an edited copy no longer matches the recorded hash.)
 */
export function pendingRequiresReplay(o: { readFailed: boolean; writeFailed: boolean }): boolean {
  return o.writeFailed;
}
