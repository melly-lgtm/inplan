// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { LogEventType, readLogSince, type LogEntry } from "@inplan/core/node";
import { isProcessAlive, latestEditorPid } from "./editorProcess";

export interface WaitResult {
  entries: LogEntry[];
  cursor: number;
  /** True when the wait ended because the editor process went away (not via a turn/close action). */
  editorGone?: boolean;
  /** True when a newer waiter claimed the doc's wait-lock and this one stepped down. */
  superseded?: boolean;
}

export interface WaitOptions {
  logPath: string;
  /** Only entries with seq greater than this are considered. */
  cursor: number;
  /** Quiescence window before reporting, to batch sequential actions. Default 3000ms. */
  debounceMs?: number;
  /** Poll interval. Default 200ms. */
  pollMs?: number;
  /** Which entries should wake the agent. Default: any user-authored entry. */
  isActionable?: (e: LogEntry) => boolean;
  /** Watch the editor pid and resolve (editorGone) if a once-alive editor dies. Default true. */
  watchEditor?: boolean;
  /** Single-waiter lock file; if its contents stop matching `lockToken`, step down (superseded). */
  lockPath?: string;
  /** This waiter's token, written into `lockPath` when it claimed the doc. */
  lockToken?: string;
  /** Abort the wait (e.g. on shutdown). */
  signal?: AbortSignal;
}

const defaultActionable = (e: LogEntry): boolean => e.actor === "user";

/**
 * The wake condition for a given cadence:
 *  - Turn mode wakes only on turn-end / session-close (not on every comment action);
 *  - Instant mode wakes on any user-authored action.
 */
export function wakePredicate(cadence: "turn" | "instant"): (e: LogEntry) => boolean {
  return cadence === "instant"
    ? (e) => e.actor === "user"
    : (e) => e.type === LogEventType.TurnEnded || e.type === LogEventType.SessionClosed;
}

/**
 * Block until the control log gains a new actionable entry past `cursor`, then —
 * after a debounce window of quiescence — resolve with all new entries and the
 * advanced cursor. This is the agent's wake mechanism; it batches a burst of
 * sequential user actions into one wake-up.
 */
export function waitForActions(opts: WaitOptions): Promise<WaitResult> {
  const debounceMs = opts.debounceMs ?? 3000;
  const pollMs = opts.pollMs ?? 200;
  const isActionable = opts.isActionable ?? defaultActionable;

  const watchEditor = opts.watchEditor ?? true;

  return new Promise<WaitResult>((resolve, reject) => {
    let deadline: number | null = null;
    let lastCount = -1;
    let sawEditorAlive = false;

    const cleanup = () => {
      clearInterval(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("wait aborted"));
    };

    const tick = () => {
      const { entries, cursor } = readLogSince(opts.logPath, opts.cursor);

      // Single-waiter lock: if a newer waiter claimed the doc, step down so only
      // one waiter is ever live (no racing / double-firing). A missing or
      // unreadable lock is treated as "still ours" (don't step down on a blip).
      if (opts.lockPath && opts.lockToken) {
        try {
          if (readFileSync(opts.lockPath, "utf8").trim() !== opts.lockToken) {
            cleanup();
            resolve({ entries, cursor, superseded: true });
            return;
          }
        } catch {
          /* lock unreadable — keep waiting */
        }
      }

      // Editor liveness: once we've seen the editor alive, exit if it goes away —
      // so a wait never lingers as a zombie after the window is gone.
      if (watchEditor) {
        const pid = latestEditorPid(opts.logPath);
        const alive = pid !== null && isProcessAlive(pid);
        if (alive) sawEditorAlive = true;
        else if (sawEditorAlive) {
          cleanup();
          resolve({ entries, cursor, editorGone: true });
          return;
        }
      }

      if (entries.some(isActionable)) {
        if (entries.length !== lastCount) {
          // New activity since last check — (re)start the debounce window.
          lastCount = entries.length;
          deadline = Date.now() + debounceMs;
        } else if (deadline !== null && Date.now() >= deadline) {
          cleanup();
          resolve({ entries, cursor });
        }
      }
    };

    const timer = setInterval(tick, pollMs);
    opts.signal?.addEventListener("abort", onAbort);
    tick();
  });
}
