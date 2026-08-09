// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, type ControlChannel, type LogEntry } from "@inplan/core/node";

/** How long a wait tolerates CONTINUOUS poll failure before giving up. Exported so the test that
 *  claims it outlasts a full refresh cooldown asserts the REAL value rather than a copy of it. */
export const DEFAULT_ERROR_GRACE_MS = 5 * 60_000;

/** How long a single channel request may take before it is abandoned. The Supabase channel has no
 *  client-side timeout on ANY of its calls, so a stall in `readSince`, `isSuperseded`, or `presence`
 *  alike pins `busy` and the wait hangs — bounding only the first would just move the hang. The two
 *  probe calls keep their existing swallow-and-continue handling: a timed-out lock or presence read
 *  means "unknown", which must not end a wait, but must not freeze it either. */
export const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** Tracks whether a previously timed-out request is STILL running.
 *
 *  `withTimeout` abandons the caller's view of a request; it cannot cancel the request itself,
 *  because `ControlChannel` exposes no `AbortSignal` (adding one reaches into `@inplan/core` and the
 *  Supabase backend — worth doing, but not in this change). Without this gate each timeout would
 *  immediately fire a duplicate while its predecessor was still in flight, stacking requests against
 *  a service that is, by hypothesis, already struggling. */
function inFlightGate(): { busy: () => boolean; run: <T>(start: () => Promise<T>, ms: number) => Promise<T> } {
  let pending = 0;
  return {
    busy: () => pending > 0,
    run: <T,>(start: () => Promise<T>, ms: number): Promise<T> => {
      pending += 1;
      const underlying = start();
      // Settle-tracking only; the rejection is surfaced by the race below, not here.
      void underlying.then(
        () => (pending -= 1),
        () => (pending -= 1),
      );
      return withTimeout(underlying, ms);
    },
  };
}

/** Reject if `p` hasn't settled within `ms`. The timer is always cleared, so a resolved poll never
 *  leaves a pending handle holding the process open. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(`poll timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WaitResult {
  /** Set when the wait gave up after repeated poll failures (expired session, network gone).
   *  A wait must END on this, never die — the agent's channel is JSON, not a stack trace. */
  failed?: Error;
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
  /** Give up only after this long of CONTINUOUS poll failure, resolving with `failed`. Expressed in
   *  TIME, not tick count, on purpose: a token refresh backs off up to 60s, during which every poll
   *  fails for one underlying reason. Counting ticks would treat a single cooldown as hundreds of
   *  independent failures and abandon the wait seconds into a backoff designed to outlast it. */
  errorGraceMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Abandon a single poll after this long. Default 30s. A hung read is NOT the same as a failing
   *  one: `busy` stays true, the interval's next tick returns immediately, and the wait neither
   *  progresses nor ever reaches `failed` — it just stops, silently, forever. Bounding each poll
   *  turns that into an ordinary failure the grace budget can reason about. */
  pollTimeoutMs?: number;
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
  const errorGraceMs = opts.errorGraceMs ?? DEFAULT_ERROR_GRACE_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const ch = opts.channel;

  return new Promise<WaitResult>((resolve, reject) => {
    let deadline: number | null = null;
    let lastCount = -1;
    let sawEditorAlive = false;
    let busy = false;
    let done = false;
    let failingSince: number | null = null; // when the current unbroken failure run started
    // One gate per call site: a stalled read must not block the lock probe, or vice versa.
    const reads = inFlightGate();
    const locks = inFlightGate();
    const presences = inFlightGate();

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
      // A previous read timed out but is still running: issuing another would stack duplicates on a
      // service that is evidently struggling. Skip this tick, and keep the failure run going so the
      // grace budget still advances toward giving up rather than stalling silently.
      if (reads.busy()) {
        const at = now();
        failingSince ??= at;
        if (at - failingSince >= errorGraceMs) finish({ entries: [], cursor: opts.cursor, failed: new Error("polls timed out and are still in flight") });
        return;
      }
      busy = true;
      try {
        const { entries, cursor } = await reads.run(() => ch.readSince(opts.cursor), pollTimeoutMs);
        if (done) return;

        // Single-waiter lock: if a newer waiter claimed the doc, step down so only
        // one waiter is ever live. A read blip is treated as "still ours".
        if (opts.token) {
          try {
            if (!locks.busy() && (await locks.run(() => ch.isSuperseded(opts.token!), pollTimeoutMs))) {
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
          // UNKNOWN and FALSE are different answers. `alive` starting at `false` meant a presence
          // call that threw was read as "the editor is gone" — and once this poll gained a timeout,
          // a mere 30s stall could end a live session with `editorGone` after a single earlier
          // success. Only a presence read that actually returned `false` may end the wait.
          let alive: boolean | undefined;
          try {
            if (!presences.busy()) alive = await presences.run(() => ch.presence(), pollTimeoutMs);
          } catch {
            /* presence unknown — keep waiting */
          }
          if (alive === true) sawEditorAlive = true;
          else if (alive === false && sawEditorAlive) {
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
        failingSince = null; // a clean poll ends the failure run
      } catch (e) {
        // A poll can fail for reasons that resolve themselves (a blip, a 5xx, an in-flight token
        // refresh) and for reasons that never will (the session is gone). Tolerate a streak, then
        // END the wait with a result. Before this, the rejection escaped `void tick()` as an
        // unhandled rejection and Node killed the process — printing a stack trace where the agent
        // expects one line of JSON, and losing the turn entirely.
        // ONE sample per failed poll: `now` is injectable, and a clock that advances per call would
        // otherwise tick twice per failure and expire the budget early.
        const at = now();
        failingSince ??= at;
        if (at - failingSince >= errorGraceMs) {
          finish({ entries: [], cursor: opts.cursor, failed: e instanceof Error ? e : new Error(String(e)) });
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
