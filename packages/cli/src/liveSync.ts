// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Helpers for the live-collab working-copy sync. The tricky decisions — "when is it safe to
// overwrite the agent's local working copy?" and "how does a hub failure degrade?" — live here so
// they can be unit-tested without a live hub, then driven from `runRemote`.

import type { DocumentStore } from "@inplan/core/node";
import type { PluginGate } from "./pluginGate";

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

export interface TrackedGate {
  /** The gate to hand to `waitCycle` — wraps the real one with graceful hub-failure handling. */
  gate: PluginGate;
  readFailed: () => boolean;
  writeFailed: () => boolean;
}

/**
 * Wrap a hub gate so failures during a turn are observable and degrade gracefully:
 *  - `readCanonical()` re-throws on failure (so `waitCycle` takes its existing local-store fallback),
 *    recording `readFailed`;
 *  - `applyRevision()` on failure persists the edit to the local store (preserve-and-retry) and does
 *    NOT re-throw — so the turn still completes and emits a status instead of crashing to
 *    `main().catch`/exit 1 — recording `writeFailed`.
 * The caller uses the flags to skip the end-of-turn re-sync and, per {@link pendingRequiresReplay},
 * mark the working copy `.pending` only when a local revision actually needs replaying (a write).
 */
export function trackGateDegradations(
  gate: PluginGate,
  localStore: Pick<DocumentStore, "setCanonical" | "saveDoc">,
  onWriteError?: (message: string) => void,
): TrackedGate {
  let readFailed = false;
  let writeFailed = false;
  return {
    readFailed: () => readFailed,
    writeFailed: () => writeFailed,
    gate: {
      readCanonical: async () => {
        try {
          return await gate.readCanonical();
        } catch (e) {
          readFailed = true;
          throw e;
        }
      },
      applyRevision: async (md) => {
        try {
          await gate.applyRevision(md);
        } catch (e) {
          writeFailed = true;
          onWriteError?.(String(e));
          await localStore.setCanonical(md);
          await localStore.saveDoc(md);
        }
      },
    },
  };
}

/** What a wait cycle did. `exiting` means it SCHEDULED a fail-fast exit (confirm_required /
 *  integrity_error) that fires from an async stdout flush rather than immediately. */
export type WaitOutcome = "ok" | "exiting";

/** What the gate path must do with the working copy once a turn ends. */
export type PostTurnAction =
  /** Touch nothing — a fail-fast exit is pending. */
  | "stop"
  /** The hub dropped mid-turn: keep the local edits and re-sync on a later run. */
  | "keep-local"
  /** Healthy turn: pull the fresh canonical so the agent's next turn builds on it. */
  | "resync";

/**
 * Decide the post-turn action from the wait's outcome and the hub's health.
 *
 * `stop` comes FIRST and unconditionally. A fail-fast turn's exit is only scheduled — it fires from
 * an async stdout flush — so without this the caller would keep running and pull a fresh hub
 * canonical over the working copy. On `confirm_required` that copy holds the agent's edit awaiting
 * the human's confirmation and exists nowhere else, so the pull can destroy exactly what the turn
 * asked to have fixed. (A bare `process.exit` used to make that unreachable; a flush-safe exit does
 * not, which is why the stop must be explicit.)
 */
export function postTurnAction(outcome: WaitOutcome, degraded: { readFailed: boolean; writeFailed: boolean }): PostTurnAction {
  if (outcome === "exiting") return "stop";
  return degraded.readFailed || degraded.writeFailed ? "keep-local" : "resync";
}
