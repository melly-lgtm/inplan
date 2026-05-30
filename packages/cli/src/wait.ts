// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, readLogSince, type LogEntry } from "@agent-planner/core/node";

export interface WaitResult {
  entries: LogEntry[];
  cursor: number;
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

  return new Promise<WaitResult>((resolve, reject) => {
    let deadline: number | null = null;
    let lastCount = -1;

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
