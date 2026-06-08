// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, type ControlChannel, type LogEntry } from "@inplan/core/node";

export interface WaitResult {
  entries: LogEntry[];
  cursor: number;
  /** True when the wait ended because the editor process went away (not via a turn/close action). */
  editorGone?: boolean;
  /** True when a newer waiter claimed the doc's wait-lock and this one stepped down. */
  superseded?: boolean;
}

export interface WaitOptions {
  /** Backend the wait reads through (fs locally; a web channel elsewhere). */
  channel: ControlChannel;
  /** Only entries with seq greater than this are considered. */
  cursor: number;
  /** Quiescence window before reporting, to batch sequential actions. Default 3000ms. */
  debounceMs?: number;
  /** Poll interval. Default 200ms. */
  pollMs?: number;
  /** Which entries should wake the agent. Default: any user-authored entry. */
  isActionable?: (e: LogEntry) => boolean;
  /** Watch editor presence and resolve (editorGone) if a once-alive editor dies. Default true. */
  watchEditor?: boolean;
  /** This waiter's single-waiter token; if a newer waiter supersedes it, step down. */
  token?: string;
  /** Abort the wait (e.g. on shutdown). */
  signal?: AbortSignal;
}

const defaultActionable = (e: LogEntry): boolean => e.actor === "user";

/**
 * The wake condition for a mode's gate policy:
 *  - "turn-end": wake only on turn-end / session-close (not on every comment action);
 *  - "any-action": wake on any user-authored action.
 */
export function wakePredicate(wake: "turn-end" | "any-action"): (e: LogEntry) => boolean {
  // Save-locally and navigate-to are control directives (the human is moving the
  // doc back to disk, or following a link to a sibling doc), so they wake the agent
  // under either policy — not just any-action.
  // A settings toggle (auto-resolve, agent mode, telemetry, …) is logged as a user
  // entry but isn't a doc/turn action — the agent reads settings when it next acts, so
  // a change must never wake a wait (otherwise toggling telemetry would end the turn).
  return wake === "any-action"
    ? (e) => e.actor === "user" && e.type !== LogEventType.SettingsChanged
    : (e) => e.type === LogEventType.TurnEnded || e.type === LogEventType.SessionClosed || e.type === LogEventType.SaveLocallyRequested || e.type === LogEventType.NavigatedTo;
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
  const ch = opts.channel;

  return new Promise<WaitResult>((resolve, reject) => {
    let deadline: number | null = null;
    let lastCount = -1;
    let sawEditorAlive = false;
    let busy = false;
    let done = false;

    const cleanup = () => {
      clearInterval(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (r: WaitResult) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(r);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("wait aborted"));
    };

    // Channel reads are async; guard against overlapping ticks and post-resolve work.
    const tick = async () => {
      if (busy || done) return;
      busy = true;
      try {
        const { entries, cursor } = await ch.readSince(opts.cursor);
        if (done) return;

        // Single-waiter lock: if a newer waiter claimed the doc, step down so only
        // one waiter is ever live. A read blip is treated as "still ours".
        if (opts.token) {
          try {
            if (await ch.isSuperseded(opts.token)) {
              finish({ entries, cursor, superseded: true });
              return;
            }
          } catch {
            /* lock unreadable — keep waiting */
          }
        }

        // Editor liveness: once we've seen the editor present, exit if it goes
        // away — so a wait never lingers as a zombie after the window is gone.
        if (watchEditor) {
          let alive = false;
          try {
            alive = await ch.presence();
          } catch {
            /* presence unknown — keep waiting */
          }
          if (alive) sawEditorAlive = true;
          else if (sawEditorAlive) {
            finish({ entries, cursor, editorGone: true });
            return;
          }
        }

        if (entries.some(isActionable)) {
          if (entries.length !== lastCount) {
            // New activity since last check — (re)start the debounce window.
            lastCount = entries.length;
            deadline = Date.now() + debounceMs;
          } else if (deadline !== null && Date.now() >= deadline) {
            finish({ entries, cursor });
          }
        }
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void tick(), pollMs);
    opts.signal?.addEventListener("abort", onAbort);
    void tick();
  });
}
