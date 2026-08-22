// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan login` — the cloud-rendezvous browser handoff. The CLI can't safely prompt for a
// password (and OAuth providers reject headless flows), so login is delegated to the web app's
// /cli-auth page. Historically the page POSTed the credentials to a one-shot 127.0.0.1 listener;
// that breaks exactly where agent workflows live — a coding agent only reads output when the
// process exits, and a CLI on a remote box can never receive a loopback POST from the human's
// browser on another machine. So the handoff now rides a short-lived CLOUD session instead
// (the collab server's /api/v1/cli-login routes):
//
//   1. Generate an ephemeral ECDH P-256 keypair; create a session; persist a pending-login
//      sidecar (0600) so a LATER invocation can finish what this one starts.
//   2. Send the human to /cli-auth?session=<id>&pub=<publicKey>. On load the page acks
//      `opened` (the cross-machine-safe "the browser really opened" signal — no ack within
//      30 s ⇒ tell the human to open the URL manually). After sign-in the page seals
//      {url, anon, refresh, email} to our public key (ECDH → HKDF-SHA256 → AES-256-GCM)
//      and posts the ciphertext to the session.
//   3. Poll the session; on completion decrypt locally (the server only ever stores bytes it
//      cannot read), persist the credentials, delete the sidecar. Sessions are single-use and
//      expire server-side in ~10 minutes.

import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthFile } from "./cliAuth";
import { hubHttpBase } from "./pluginGate";

const subtle = webcrypto.subtle;

/** The web app origin that hosts /cli-auth. Overridable for self-hosted / dev. */
const DEFAULT_WEB_ORIGIN = process.env.INPLAN_WEB_URL || "https://inplan.ai";
/** HKDF domain separation — MUST match the /cli-auth page's sealer exactly. */
const HKDF_INFO = "inplan cli-login v1";
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 2_000;
/** No `opened` ack by this long ⇒ the browser likely never opened — nudge the human. */
const NUDGE_MS = 30_000;
/** Per-request bound: a stalled TCP connection must not hang the CLI silently (create) or stop
 *  the poll loop's deadline from ever being re-checked (poll). */
const REQUEST_TIMEOUT_MS = 15_000;

/** The collab server's HTTP base — pluginGate's single ws(s)→http(s) mapping, so the login and
 *  the plugin gate can never derive different endpoints from the same hub URL. */
export function loginApiBase(): string {
  return hubHttpBase();
}

export interface RendezvousDeps {
  fetchImpl?: typeof fetch;
  /** Launch the system browser at `url`, reporting a failed launch (and how certain it is) through
   *  the callback. Overridable in tests. Default: OS opener ({@link openInBrowser}). */
  open?: (url: string, onLaunchFailure?: (kind: LaunchFailure) => void) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RendezvousLoginOptions extends RendezvousDeps {
  webOrigin?: string;
  apiBase?: string;
  /** How long the foreground command waits before giving up (the session itself lives longer,
   *  so a follow-up invocation can still resume it). */
  timeoutMs?: number;
  /** Notified with the handoff URL so the caller can print a manual fallback. */
  onUrl?: (url: string) => void;
  /** Fired once if the page hasn't acked `opened` within NUDGE_MS — "open the URL manually". */
  onNudge?: () => void;
  /** Bail out with {@link BrowserDidNotOpenError} when the page hasn't acked `opened` within this
   *  window. Lets a caller *try* launching a browser and fall back to the print-the-URL flow only
   *  when the launch demonstrably failed. This is the BACKSTOP, not the primary signal: a timeout
   *  cannot distinguish "no browser" from "a browser that is still starting", so keep it generous
   *  and let `launchFailed` catch the common case. Unset (the default) waits the full `timeoutMs`. */
  openAckMs?: number;
  /** Fires when the browser launch has been observed to fail CERTAINLY — i.e. there is no opener
   *  process at all. A definite answer rather than a timeout's guess, so it ends the wait
   *  immediately with {@link BrowserDidNotOpenError} instead of sitting out `openAckMs`. Callers
   *  must not wire a merely-suspicious signal (an opener exiting non-zero) in here: that would
   *  trade a slow fallback for a wrong one.
   *
   *  A SIGNAL, not a predicate, because the opener reports asynchronously: the report can land
   *  while a stalled poll request is in flight, and a predicate could only be re-read after that
   *  request had run its budget out. Wiring it into the request's abort makes the fallback immediate
   *  in that case too. */
  launchSignal?: AbortSignal;
}

/** A login this process started (or a previous one left behind): everything a later invocation
 *  needs to finish the handoff. The private key never leaves this machine. */
export interface PendingLogin {
  sessionId: string;
  /** Our ephemeral ECDH private key (PKCS#8, base64) — decrypts the sealed handoff. */
  privateKeyPkcs8: string;
  /** The CLI-only poll credential (returned once at create; the server stores only its hash).
   *  Polling requires it, so the browser-facing session id in the URL is not a claim capability
   *  — a leaked URL can neither read nor destroy the handoff. Sent via an unlogged header. */
  pollToken: string;
  url: string;
  apiBase: string;
  expiresAt: number; // epoch ms
}

/** `~/.inplan/login-pending.json` — `INPLAN_HOME` overrides the base dir (tests). */
export function pendingLoginPath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "login-pending.json");
}

export function clearPendingLogin(): void {
  try {
    unlinkSync(pendingLoginPath());
  } catch {
    /* already gone */
  }
}

/** Serialize sidecar ownership (read-check-delete-create) with a tiny advisory lock: an atomic
 *  mkdir held for microseconds. Without it, a delayed poll's owner-check and unlink could
 *  interleave with a fresh login's write and erase the newcomer. A lock outliving the spin
 *  budget is stolen — a crashed holder must not brick logins forever. */
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 25;
/** A lock this old belongs to a dead process — the real critical sections are file-touch sized. */
const LOCK_STALE_MS = 5000;

async function withSidecarLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lock = pendingLoginPath() + ".lock";
  // Ensure the base dir exists first. On a machine that has never run inplan, ~/.inplan/ is absent,
  // so the lock mkdir below would throw ENOENT (not the retryable EEXIST) and bubble up — breaking
  // first-ever login, and any `inplan login` that reaches the sidecar before a dir-creating write.
  // Owner-only (0o700): it holds the auth session + refresh token (the pending file is 0o600). mode
  // is masked by umask, but 0o700 has no group/other bits to begin with, so the dir is never wider.
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { recursive: false });
      break;
    } catch (e) {
      // Only contention is retryable — an unwritable path or a pre-existing regular file would
      // otherwise spin forever with no way out.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Steal only a lock that is provably STALE (holder long dead), never one that is merely
      // slower than our patience — stealing a live lock would re-open the very race this
      // serializes. Our own wait is bounded separately.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        /* the holder released it between our checks — loop and retry */
      }
      if (Date.now() > deadline) throw new Error("could not acquire the login lock — another inplan process is holding it");
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS)); // yield, don't burn a core
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already released */
    }
  }
}

/** Remove the sidecar ONLY if it still belongs to `sessionId`. A delayed poll of an OLD session
 *  (expired, claimed, undecryptable) must never erase a NEWER pending login that replaced it —
 *  that would make the replacement's printed URL impossible to resume. Owner-check + unlink run
 *  as one critical section, so the check can't go stale before the delete. */
async function clearPendingLoginFor(sessionId: string): Promise<void> {
  await withSidecarLock(() => {
    const path = pendingLoginPath();
    try {
      const p = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: unknown };
      if (p.sessionId !== sessionId) return; // a newer login owns the slot now — leave it alone
    } catch {
      /* unreadable/absent → nothing to protect */
    }
    clearPendingLogin();
  });
}

/** Lock-free read + cleanup — ONLY for use inside withSidecarLock (the lock is not re-entrant). */
function loadPendingLoginLocked(now: number): PendingLogin | null {
  const path = pendingLoginPath();
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as PendingLogin;
    if (
      typeof p.sessionId !== "string" ||
      typeof p.privateKeyPkcs8 !== "string" ||
      typeof p.pollToken !== "string" ||
      typeof p.url !== "string" ||
      typeof p.apiBase !== "string" ||
      typeof p.expiresAt !== "number" ||
      p.expiresAt <= now
    ) {
      clearPendingLogin();
      return null;
    }
    return p;
  } catch {
    clearPendingLogin();
    return null;
  }
}

/** The pending login a previous invocation left behind, if it can still complete. An expired or
 *  unreadable sidecar is cleared and reads as absent — the read and that cleanup run under the
 *  sidecar lock, so a delayed reader of an OLD sidecar can never delete a fresh replacement that
 *  landed in between. */
export function loadPendingLogin(now: number = Date.now()): Promise<PendingLogin | null> {
  return withSidecarLock(() => loadPendingLoginLocked(now));
}

/** Create a rendezvous session + the sidecar that lets ANY later invocation finish it. */
export async function createLoginSession(opts: RendezvousLoginOptions = {}): Promise<PendingLogin> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  // Adopt an existing valid pending login BEFORE minting anything: the common repeat-invocation
  // path must not burn a keypair + a server session row just to throw them away in the locked
  // adoption check below (which stays, for the true concurrent race).
  const existing = await loadPendingLogin(now());
  if (existing) return existing;
  const apiBase = opts.apiBase ?? loginApiBase();
  const webOrigin = (opts.webOrigin ?? DEFAULT_WEB_ORIGIN).replace(/\/$/, "");

  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = Buffer.from(await subtle.exportKey("spki", keys.publicKey)).toString("base64");
  const priv = Buffer.from(await subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");

  const res = await fetchImpl(`${apiBase}/api/v1/cli-login`, { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`could not start a sign-in session (HTTP ${res.status})`);
  const { sessionId, pollToken, expiresInSec } = (await res.json()) as { sessionId: string; pollToken: string; expiresInSec: number };
  if (typeof sessionId !== "string" || !sessionId || typeof pollToken !== "string" || !pollToken) {
    throw new Error("could not start a sign-in session (bad response)");
  }

  const pending: PendingLogin = {
    sessionId,
    privateKeyPkcs8: priv,
    pollToken,
    // `pub` rides the URL FRAGMENT so it never reaches server access logs (a log reader holding
    // session + pub could complete the session for their own account); the page reads it from
    // location.hash. Public key or not, keep the whole capability out of logs.
    url: `${webOrigin}/cli-auth?session=${encodeURIComponent(sessionId)}#pub=${encodeURIComponent(pub)}`,
    apiBase,
    // Guard against a bogus server TTL: NaN/Infinity/negative would make expiresAt a past
    // timestamp — or one that NEVER expires (NaN compares false forever), leaving a dead sidecar
    // that every later invocation resumes until the server 404s.
    expiresAt: now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 600) * 1000,
  };
  const path = pendingLoginPath();
  mkdirSync(dirname(path), { recursive: true });
  // EXCLUSIVE ownership: two concurrent commands must not each mint a session with the second
  // overwriting the first (whose printed URL would then be unresumable — its private key gone).
  // Inside the lock: adopt a still-valid winner, otherwise take the slot — one critical section,
  // so there is no second write race to lose.
  return withSidecarLock(() => {
    const winner = loadPendingLoginLocked(now());
    if (winner) return winner;
    writeFileSync(path, JSON.stringify(pending, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600); // belt-and-braces: mode can be masked by umask
    return pending;
  });
}

/** Distinguishes "this session can never complete" (sidecar cleared; start fresh) from a
 *  foreground timeout (sidecar kept; a later invocation resumes). */
export class LoginSessionExpiredError extends Error {}

/** The browser never acked `opened` within `openAckMs`, so the launch almost certainly failed.
 *  The rendezvous session is left INTACT (not cleared): the caller is expected to hand the URL to
 *  a human and resume this same session, so it must stay claimable. */
export class BrowserDidNotOpenError extends Error {}

/**
 * Poll `pending` until the page posts the sealed handoff, then decrypt + return the credentials
 * (the sidecar is deleted on success — sessions are single-use). Throws LoginSessionExpiredError
 * when the session is gone server-side (also clears the sidecar), or a plain Error on foreground
 * timeout (the sidecar survives so the NEXT invocation picks the login up — the coding-agent loop).
 */
/** How long a single poll request may take: the smaller of the per-request cap, the foreground
 *  budget, and — while we are still waiting for the page's `opened` ack — the ack window. Without
 *  that last term a stalled request burns the full REQUEST_TIMEOUT_MS (plus a POLL_MS sleep) before
 *  the loop re-checks a 6-second window, so the browser-did-not-open fallback arrives far too late
 *  to be the "cheap attempt" it is meant to be. Never returns 0 — AbortSignal.timeout(0) aborts
 *  immediately, turning a tight budget into a request that never goes out at all. */
export function pollRequestBudgetMs(nowMs: number, deadline: number, openAckDeadline?: number): number {
  const budgets = [REQUEST_TIMEOUT_MS, deadline - nowMs];
  if (openAckDeadline !== undefined) budgets.push(openAckDeadline - nowMs);
  return Math.max(1, Math.min(...budgets));
}

/** One abort signal covering both reasons to stop a poll request early: its own time budget, and
 *  the launcher reporting that no browser is coming. */
function launchAwareSignal(budgetMs: number, launchSignal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(budgetMs);
  return launchSignal ? AbortSignal.any([budget, launchSignal]) : budget;
}

export async function pollLoginSession(pending: PendingLogin, opts: RendezvousLoginOptions = {}): Promise<AuthFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const nudgeAt = now() + NUDGE_MS;
  const openAckDeadline = opts.openAckMs === undefined ? undefined : now() + opts.openAckMs;
  let nudged = false;
  let sawOpened = false;
  /** The launch is known to have failed AND the page never acked — an ack outranks the launcher. */
  const launchDead = (): boolean => !sawOpened && Boolean(opts.launchSignal?.aborted);

  while (true) {
    // The nudge is a TIMER, not a response property: if the page hasn't acked `opened` by the
    // window — including when the hub is unreachable or answering 5xx/garbage, exactly when the
    // human is most likely staring at a browser that never opened — say so once.
    if (!nudged && !sawOpened && now() >= nudgeAt) {
      nudged = true;
      opts.onNudge?.();
    }
    // The opener itself reported failure (missing binary, non-zero exit). That is knowledge, not a
    // guess, so stop now rather than waiting out `openAckMs` — and check it BEFORE the deadline so
    // the definite reason wins. `sawOpened` still overrides: if the page acked, a grumpy exit code
    // from the launcher is irrelevant, the browser plainly got there.
    if (launchDead()) throw new BrowserDidNotOpenError("the browser could not be launched");
    // Give up EARLY (session untouched) when the caller only wanted to know whether the browser
    // came up: no `opened` ack inside the window means the launch failed, and the caller has a
    // better fallback than waiting out the full timeout.
    if (openAckDeadline !== undefined && !sawOpened && now() >= openAckDeadline) {
      throw new BrowserDidNotOpenError("the browser did not open");
    }
    if (now() >= pending.expiresAt) {
      await clearPendingLoginFor(pending.sessionId);
      throw new LoginSessionExpiredError("the sign-in link expired — run the command again for a fresh one");
    }
    if (now() >= deadline) throw new Error("login timed out — no response from the browser");

    let res: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      res = await fetchImpl(`${pending.apiBase}/api/v1/cli-login/${encodeURIComponent(pending.sessionId)}`, {
        method: "GET",
        // The poll credential rides a header (never a URL, so never an access log) — see
        // PendingLogin.pollToken: the session id alone must not read or destroy the handoff.
        headers: { "x-inplan-poll-token": pending.pollToken },
        // Capped to the REMAINING deadline — and to the openAck deadline when one is set: an
        // in-flight request must not let either budget overrun by a whole request-timeout. Without
        // the second cap a stalled poll could burn the full REQUEST_TIMEOUT_MS (plus a POLL_MS
        // sleep) before the loop ever re-checks a 6-second ack window.
        // Cut the request short on a launch failure too, not just on the budget: the opener reports
        // asynchronously, so without this a report landing mid-request would sit behind a stalled
        // connection for the whole budget before the loop could act on it.
        // BOTH extra bounds fall away once the page has acked. The ack window has done its job — and
        // an AbortSignal stays aborted forever, so a launch signal that has already fired would make
        // AbortSignal.any born-aborted for every remaining request: each one dies before it leaves,
        // `launchDead()` rightly declines to throw (the page acked), so the loop sleeps and retries
        // into the same instant abort until the foreground deadline. A login that was about to
        // complete would end as "login timed out" instead.
        signal: launchAwareSignal(
          pollRequestBudgetMs(now(), deadline, sawOpened ? undefined : openAckDeadline),
          sawOpened ? undefined : opts.launchSignal,
        ),
      });
    } catch {
      // Was that abort the launcher telling us there is no browser? Then it is the answer, not a
      // blip — fall back now instead of sleeping and retrying against a browser that never opened.
      if (launchDead()) throw new BrowserDidNotOpenError("the browser could not be launched");
      // Transient transport failure (DNS blip, dropped connection, a stalled request cut by the
      // per-request timeout): retry like a 5xx — the session is still valid, and the foreground
      // deadline above bounds the total wait. Only a 404 (below) ends the session for good.
      await sleep(POLL_MS);
      continue;
    }
    if (res.status === 404) {
      // Unknown/expired/already-claimed server-side — this pending login can never complete.
      await clearPendingLoginFor(pending.sessionId);
      throw new LoginSessionExpiredError("the sign-in link expired — run the command again for a fresh one");
    }
    if (res.ok) {
      let body: { status?: string; epk?: string; iv?: string; ct?: string };
      try {
        body = (await res.json()) as { status?: string; epk?: string; iv?: string; ct?: string };
      } catch {
        // A 200 with an empty/non-JSON body (proxy hiccup, captive portal) is as transient as a
        // dropped connection — retry within the deadline instead of killing a valid session's wait.
        await sleep(POLL_MS);
        continue;
      }
      if (body.status === "completed" && body.epk && body.iv && body.ct) {
        let auth: AuthFile;
        try {
          auth = await unsealHandoff(pending.privateKeyPkcs8, { epk: body.epk, iv: body.iv, ct: body.ct });
        } catch {
          // The handoff can't be decrypted (wrong key / corrupt ciphertext) — and the claim-once
          // GET already consumed the row, so this session can NEVER complete. Clear the sidecar
          // and report it like an expiry, so the caller starts a FRESH session instead of
          // treating a permanently-dead login as a transient failure to retry.
          await clearPendingLoginFor(pending.sessionId);
          throw new LoginSessionExpiredError("the sign-in handoff could not be read — run the command again for a fresh link");
        }
        await clearPendingLoginFor(pending.sessionId);
        return auth;
      }
      if (body.status === "opened" || body.status === "completed") sawOpened = true;
    }
    await sleep(POLL_MS);
  }
}

/** The one-command human flow: create a session, open the browser, poll to completion inline. */
export async function rendezvousLogin(opts: RendezvousLoginOptions = {}): Promise<AuthFile> {
  const pending = await createLoginSession(opts);
  opts.onUrl?.(pending.url);
  (opts.open ?? openInBrowser)(pending.url);
  return pollLoginSession(pending, opts);
}

/** How a browser launch failed, and — the part that matters — how sure we are.
 *  - `no-opener`: there is no opener process at all (spawn threw, or ENOENT arrived as an 'error'
 *    event). CERTAIN: nothing was launched, so nothing is coming.
 *  - `opener-declined`: the opener ran and exited non-zero. A GOOD signal, NOT a certain one — some
 *    sandboxed/desktop configurations return non-zero having launched the browser anyway. */
export type LaunchFailure = "no-opener" | "opener-declined";

/**
 * Best-effort: open `url` in the OS browser. Errors never propagate — the URL is also printed so
 * the user can open it by hand (and the 30 s no-`opened` nudge re-prompts).
 *
 * `onLaunchFailure` turns the launch from fire-and-forget into something OBSERVABLE. The opener
 * tells us plainly when it could not do its job, and discarding that is what forced the caller to
 * infer a failed launch from the *absence* of the page's ack — which can only ever be a timeout, and
 * so can only ever call a slow browser a broken one. It reports WHICH kind of failure because the
 * two deserve different treatment: see {@link LaunchFailure}. Fires at most once.
 */
export function openInBrowser(url: string, onLaunchFailure?: (kind: LaunchFailure) => void): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  let reported = false;
  const failed = (kind: LaunchFailure): void => {
    if (reported) return;
    reported = true;
    onLaunchFailure?.(kind);
  };
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // A missing opener (headless/CI) surfaces as an async 'error' event, not a sync throw — handle
    // it so it can't become an unhandled error and crash before the printed-URL fallback.
    child.on("error", () => failed("no-opener"));
    // The opener is a launcher, not the browser: it exits within milliseconds and its code is a hint
    // about whether it handed the URL off. Only a HINT — hence `opener-declined` rather than a
    // verdict. NB this handler depends on the parent outliving a `detached: true` + `unref()`'d
    // child, which `unref()` normally disclaims; it holds here only because the caller goes straight
    // into the poll loop and so stays alive well past the opener's few milliseconds.
    child.on("exit", (code) => {
      if (code !== 0) failed("opener-declined");
    });
    child.unref();
  } catch {
    failed("no-opener"); // opener missing (headless/CI) — the printed URL is the fallback
  }
}

/** Decrypt the page's sealed handoff: ECDH(P-256) → HKDF-SHA256(salt=∅, info=HKDF_INFO) →
 *  AES-256-GCM — the exact inverse of the page's `sealCliLogin`. */
async function unsealHandoff(privateKeyPkcs8: string, sealed: { epk: string; iv: string; ct: string }): Promise<AuthFile> {
  const privateKey = await subtle.importKey("pkcs8", Buffer.from(privateKeyPkcs8, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const epk = await subtle.importKey("spki", Buffer.from(sealed.epk, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64") }, aes, Buffer.from(sealed.ct, "base64"));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as {
    url?: string;
    anon?: string;
    refresh?: string;
    email?: string;
    /** OPTIONAL, and the reason this half exists. A refresh token is single-use, so a handoff
     *  carrying one alone is good for exactly one rotation — and if the page's own client rotates
     *  first, for none at all, which is the bug this branch chases. Sealing the live ACCESS token
     *  alongside it hands the CLI a credential NOBODY rotates.
     *
     *  That is what lets `primeSessionOrFail` prove the credential without spending the rotation:
     *  with this pair present it validates through the access token and leaves the refresh token
     *  untouched, so the CLI never has to win a race against the page's own client just to sign in.
     *  Taken only as a MATCHED pair — a token whose lifetime we cannot check is worse than none,
     *  since it could only be trusted blindly or ignored.
     *
     *  It proves the session works now, not that the refresh token is still live; the only test for
     *  that is to spend it. See primeSessionOrFail for that residual and the durable fix.
     *
     *  Absent on older pages, so both fields stay optional and the flow degrades to the
     *  forced-refresh route. */
    access?: string;
    /** Epoch SECONDS (Supabase's `session.expires_at`), matching AuthFile.expiresAt. */
    expiresAt?: number;
  };
  if (typeof parsed.url !== "string" || typeof parsed.anon !== "string" || typeof parsed.refresh !== "string") {
    throw new Error("sign-in handoff was malformed");
  }
  // Take the access token only as a matched pair with its expiry: a token whose lifetime we can't
  // check is worse than none, since reuseCached would have to either trust it blindly or ignore it.
  const cached = typeof parsed.access === "string" && typeof parsed.expiresAt === "number" ? { accessToken: parsed.access, expiresAt: parsed.expiresAt } : {};
  return {
    url: parsed.url,
    anonKey: parsed.anon,
    refreshToken: parsed.refresh,
    ...(parsed.email ? { email: parsed.email } : {}),
    ...cached,
  };
}
