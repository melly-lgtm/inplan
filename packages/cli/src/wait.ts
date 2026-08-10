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

/** How long a `window_closed` close may linger before it is believed. A page RELOAD tears the
 *  editor down (which logs the close) and is typically back within seconds; ending the agent's
 *  wait on that signal alone strands the returning human with nobody attached. */
export const REOPEN_GRACE_MS = 3 * 60_000;

/**
 * After a `window_closed` session-close: watch for the human coming BACK within `graceMs` —
 * either a NEW user-authored entry past `cursor`, or editor presence turning alive again (a
 * reload appends no events, so the presence heartbeat is the only signal for a silent return).
 * Resolves "reopened" on resumption, "expired" when the grace passes in silence (they really
 * left), and "superseded" the moment a NEWER waiter claims the doc's wait-lock — the grace must
 * not let a stale waiter outlive its replacement and steal the lock back on resume. Every probe
 * is bounded by the REMAINING grace (a stalled channel read must not park the watch forever),
 * and transient failures don't abort it.
 */
/** The wait-lock a cycle should use, and whether it must CLAIM it.
 *
 *  A fresh cycle mints a token and claims the doc. A RESUMED cycle (after a reopen grace) carries
 *  its original token and must NOT claim: claiming would overwrite a newer waiter's token — a stale
 *  waiter stealing the lock back from its replacement, exactly what the grace is documented never to
 *  allow. Keeping the old token means the worst case is losing, since the poll loop's
 *  `isSuperseded(token)` check steps a superseded waiter down on its first tick. */
/** What the grace watch concluded. `completed` carries the cursor and entries FROM THE GRACE READ:
 *  the caller persisted its cursor before the grace began, so without these the SessionClosed that
 *  ended the session is never recorded and the next wait re-reads and re-reports it. */
export type ReopenOutcome =
  | { kind: "reopened" }
  | { kind: "expired" }
  | { kind: "superseded" }
  | { kind: "completed"; cursor: number; entries: LogEntry[] };

export function lockForCycle(resumeToken: string | undefined, mint: () => string): { token: string; claim: boolean } {
  return resumeToken ? { token: resumeToken, claim: false } : { token: mint(), claim: true };
}

export async function awaitReopen(
  channel: ControlChannel,
  cursor: number,
  opts: {
    graceMs?: number;
    pollMs?: number;
    /** Per-probe bound; additionally capped to the remaining grace. Default 10s. */
    probeTimeoutMs?: number;
    /** This waiter's wait-lock token; when set, a newer claimant resolves "superseded". */
    token?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ReopenOutcome> {
  const graceMs = opts.graceMs ?? REOPEN_GRACE_MS;
  const pollMs = opts.pollMs ?? 2000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + graceMs;
  // Only a heartbeat FRESHER than this counts as a reopen: a window_closed's presence heartbeat
  // lingers for the backend's TTL, so a `presence()` read right after the close reports the OLD
  // editor, not a return — which would resume a dead session (its stale heartbeat then expires and
  // ends the wait, defeating the grace). Gate presence on "written since we started watching".
  const graceStart = now();
  // Per-probe bound = min(probeTimeoutMs, remaining grace): a probe that loses the race keeps
  // running but is abandoned — the grace budget, not the channel's health, decides when to stop.
  const budget = (): number => Math.max(1, Math.min(opts.probeTimeoutMs ?? 10_000, deadline - now()));
  // Independent in-flight gates per probe. A probe that stalls during an outage times out for THIS
  // iteration, but its underlying request is not cancellable and keeps pending — the gate skips
  // launching another on top of it, so timed-out reads don't stack across the grace window.
  const supersede = inFlightGate();
  const reads = inFlightGate();
  const presences = inFlightGate();
  while (now() < deadline) {
    // Each probe gets its OWN try/catch. A single catch around all three meant a timing-out lock or
    // log read skipped the healthy ones for that iteration — so during a read outage a returning
    // editor's presence heartbeat could not resume the wait, which is the one signal that matters.
    if (opts.token && !supersede.busy()) {
      try {
        if (await supersede.run(() => channel.isSuperseded(opts.token!), budget())) return { kind: "superseded" };
      } catch {
        /* lock unreadable this iteration — keep watching; a missed supersede is retried next poll */
      }
    }
    if (!reads.busy()) {
      try {
        const { entries, cursor: readCursor } = await reads.run(() => channel.readSince(cursor), budget());
        // An explicit `completed` (the build handoff) logged DURING the grace ends it immediately.
        // Without this it was ignored for the full window and then reported as `window_closed` —
        // the deliberate handoff both delayed by minutes and mislabelled. A newer `window_closed`
        // is NOT terminal: that is still just another reload.
        //
        // Requires an EXPLICIT non-window_closed reason. Defaulting a bare SessionClosed to
        // "completed" would end the grace on an ambiguous signal; when in doubt keep watching, since
        // the grace can only expire naturally, whereas ending early strands a returning human.
        const closed = entries.find((e) => {
          if (e.type !== LogEventType.SessionClosed) return false;
          const reason = (e.payload as { reason?: string } | undefined)?.reason;
          return reason !== undefined && reason !== "window_closed";
        });
        if (closed) return { kind: "completed", cursor: readCursor, entries };
        if (entries.some((e) => e.actor === "user" && e.type !== LogEventType.SessionClosed)) return { kind: "reopened" };
      } catch {
        /* log read timed out or failed transiently — presence below can still prove the return */
      }
    }
    if (!presences.busy()) {
      try {
        if (await presences.run(() => channel.presence(graceStart), budget())) return { kind: "reopened" };
      } catch {
        /* presence unreadable this iteration — keep watching until the grace expires */
      }
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
  }
  return { kind: "expired" };
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
