// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI ⇄ cloud authentication. A logged-in human stores a long-lived refresh
// token in `~/.inplan/auth.json`; the CLI exchanges it for a short-lived JWT and
// drives a cloud document under that user's identity (RLS applies — the user
// must belong to the document's org). The service-role key is NEVER used here:
// the local CLI runs as the human, the same as the browser SPA.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { ControlChannel, DocumentStore } from "@inplan/core";
import { mintProposalId } from "@inplan/core";
import { SupabaseControlChannel, SupabaseDocumentStore } from "@inplan/backend-supabase";
import { sidecarRoot } from "./paths";

// supabase-js builds a RealtimeClient eagerly in createClient, which throws on a
// Node without a global WebSocket (e.g. Electron's bundled Node 20, used when the
// desktop app shells back out to the CLI). The CLI never opens a Realtime socket —
// it polls — but we still hand it a `ws` transport so construction can't fail.
// `ws`'s WebSocket type differs structurally from the DOM lib's; supabase-js only
// needs a constructor it can `new`, so cast past the cosmetic mismatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realtimeTransport = { transport: WebSocket } as any;

/** Persisted CLI credentials. The anon key + URL identify the deployment; the
 *  refresh token is the user's session (rotated on each refresh). The email is a
 *  cached display label (captured from the refreshed session), not authoritative. */
export interface AuthFile {
  url: string;
  anonKey: string;
  refreshToken: string;
  email?: string;
  /** Cached short-lived access token (JWT) + its epoch-seconds expiry. Lets a CLI op reuse a
   *  still-valid session WITHOUT a refresh (which rotates the refresh token) — so concurrent
   *  processes don't race the single-use rotation. Absent right after login (first op refreshes). */
  accessToken?: string;
  expiresAt?: number;
}

/** `~/.inplan/auth.json` — `INPLAN_HOME` overrides the base dir (tests; avoids $HOME). */
export function authPath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "auth.json");
}

/** Read stored credentials, or null if not logged in / unreadable. */
export function loadAuth(): AuthFile | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthFile>;
    if (typeof raw.url === "string" && typeof raw.anonKey === "string" && typeof raw.refreshToken === "string") {
      return {
        url: raw.url,
        anonKey: raw.anonKey,
        refreshToken: raw.refreshToken,
        ...(raw.email ? { email: raw.email } : {}),
        ...(typeof raw.accessToken === "string" ? { accessToken: raw.accessToken } : {}),
        ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist credentials with owner-only permissions (it holds a session token). */
export function saveAuth(auth: AuthFile): void {
  const path = authPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic replace: write a 0600 temp file in the same dir, then rename over auth.json, so a
  // concurrent (lockless fast-path) loadAuth can never observe a half-written file. rename is
  // atomic within a filesystem; the temp name is pid-scoped to avoid two writers colliding.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  renameSync(tmp, path);
}

/** Forget the stored credentials (sign out). No-op if not logged in. */
export function clearAuth(): void {
  const path = authPath();
  if (existsSync(path)) rmSync(path, { force: true });
}

/** An authenticated client + the refreshed session for the logged-in user. */
export interface AuthedSession {
  db: SupabaseClient;
  session: Session;
}

// Cross-process mutex over auth.json. Supabase rotates refresh tokens (single-use, ~10s reuse
// window), so an unsynchronized read→refresh→write lets concurrent `inplan` processes clobber the
// file with a token another already rotated away — which then gets revoked and kills the whole
// session (observed: a `wait` loop + any concurrent command). Serializing the critical section,
// and loading INSIDE the lock so each refresher starts from the freshest token, closes the race.
const LOCK_WAIT_MS = 10_000; // stop waiting after this and report non-acquisition (never deadlock)
// A lock older than this is assumed abandoned (crashed holder) and reclaimed. Set well above any
// plausible refresh (a token refresh is ~1s) so a live refresh is never reclaimed out from under us.
const LOCK_STALE_MS = 60_000;

/** Tunable timings — overridable in tests. */
export interface AuthLockOpts {
  waitMs?: number;
  staleMs?: number;
}

function lockDir(): string {
  return join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "auth.lock");
}
function lockOwnerPath(): string {
  return join(lockDir(), "owner");
}

/**
 * Run `fn` while holding an exclusive cross-process lock over auth.json. Returns
 * `{ acquired: true, value }` ONLY when this process held the lock for the whole of `fn`. If the
 * lock can't be acquired within `waitMs`, returns `{ acquired: false }` WITHOUT running `fn` — the
 * caller must NOT then refresh unlocked (concurrent refreshSession rotates the single-use token and
 * logs the session out). Reclaiming an abandoned lock is atomic (rename-aside), so two racers can
 * never both "steal" and proceed. Exported for the concurrency tests.
 */
export async function withAuthLock<T>(
  fn: (fence: { stillMine: () => boolean }) => Promise<T>,
  opts: AuthLockOpts = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lock = lockDir();
  mkdirSync(process.env.INPLAN_HOME || join(homedir(), ".inplan"), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + waitMs;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock); // atomic create — fails (EEXIST) if a holder exists
      writeFileSync(lockOwnerPath(), token);
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Reclaim an abandoned lock ATOMICALLY: rename it aside — only one racer's rename can succeed,
      // so we never delete a lock a peer just (re)acquired (a `stat`-then-`rm` had that race). A
      // fresh lock isn't stale, so a live refresh is never reclaimed.
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          const aside = `${lock}.stale-${token}`;
          renameSync(lock, aside); // atomic; throws if another racer already moved/removed it
          rmSync(aside, { recursive: true, force: true });
          continue; // retry mkdir immediately
        }
      } catch {
        continue; // lock vanished / we lost the reclaim race — just retry acquiring
      }
      await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 40)));
    }
  }
  if (!held) return { acquired: false }; // never run fn() unlocked — a racing refresh would corrupt the session
  // Ownership fence: the owner marker still carries OUR token. If this process was paused (SIGSTOP,
  // laptop sleep, a blocked event loop) past staleMs, a waiter can reclaim the lock and write its own
  // token; when we resume we're no longer the owner. Callers MUST re-check `stillMine()` immediately
  // before any single-use side effect (the refresh-token rotation) so a stolen holder aborts instead
  // of rotating alongside the new owner. Narrows the window to the check→act gap (a few ms), vs. the
  // whole of `fn`.
  const stillMine = (): boolean => {
    try {
      return readFileSync(lockOwnerPath(), "utf8") === token;
    } catch {
      return false; // owner file gone / lock reclaimed ⇒ not ours
    }
  };
  // Heartbeat: keep renewing the lock's mtime while we hold it, so a LIVE holder is never reclaimed
  // on age alone even if `fn` runs longer than staleMs (a slow/hung network refresh). Only a CRASHED
  // (or paused) holder stops the heartbeat → the lock actually goes stale and a waiter can reclaim it.
  // Guard on `stillMine()` so a resumed-after-reclaim holder never renews a SUCCESSOR's lock (which
  // would wrongly keep the new owner's lock fresh / fight its heartbeat). The timer fires on the event
  // loop during `fn`'s awaits; unref so it never keeps the process alive.
  const beat = setInterval(() => {
    try {
      if (stillMine()) utimesSync(lock, new Date(), new Date());
    } catch {
      /* released/removed — nothing to renew */
    }
  }, Math.max(1, Math.floor(staleMs / 3)));
  if (typeof beat.unref === "function") beat.unref();
  try {
    return { acquired: true, value: await fn({ stillMine }) };
  } finally {
    clearInterval(beat);
    try {
      // Only release a lock we still own (see `token`) — never delete a successor's.
      if (readFileSync(lockOwnerPath(), "utf8") === token) rmSync(lock, { recursive: true, force: true });
    } catch {
      /* owner file gone / lock already reclaimed — leave it for its current owner */
    }
  }
}

/**
 * Exchange the stored refresh token for an authenticated client. Persists the
 * rotated refresh token (and the session's email, for display) back to
 * `auth.json` so the next invocation starts fresh. Returns null when not logged
 * in or the session can't be refreshed (callers print "run `inplan login`").
 */
/** Refresh two minutes before expiry so a reused token never lands on a just-expired boundary. */
const ACCESS_SKEW_S = 120;

// A CLI client that never refreshes on its own: short-lived ops refresh explicitly (below), and
// leaving auto-refresh on would silently rotate the refresh token in-memory during a long `wait`
// without persisting it — invalidating auth.json.
function newClient(auth: AuthFile): SupabaseClient {
  return createClient(auth.url, auth.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: realtimeTransport,
  });
}

/** Bind a client to a still-valid cached access token WITHOUT a network refresh (no rotation).
 *  Returns null if there's no usable cached token or it's within `skewS` of expiry. `skewS` defaults
 *  to the refresh skew (proactively re-mint before expiry); pass 0 to accept any not-yet-expired
 *  token (the contention fallback, where the token is still usable while a peer refreshes). */
async function reuseCached(auth: AuthFile, skewS = ACCESS_SKEW_S): Promise<AuthedSession | null> {
  if (!auth.accessToken || !auth.expiresAt) return null;
  if (auth.expiresAt - Math.floor(Date.now() / 1000) <= skewS) return null;
  const db = newClient(auth);
  // setSession only decodes+stores when the access token is unexpired (no network call, no
  // rotation). We've already checked expiry, so this is purely local.
  const { data, error } = await db.auth.setSession({ access_token: auth.accessToken, refresh_token: auth.refreshToken });
  return error || !data.session ? null : { db, session: data.session };
}

/** Proactive margin for a LONG-LIVED `wait`: refresh this far before expiry so a failure has room to
 *  retry. The 2-minute {@link ACCESS_SKEW_S} leaves ~2 minutes of budget, which is how a single bad
 *  refresh became a dead session. One-shot commands keep the small skew — they exit immediately, and
 *  a wide margin there would only rotate the single-use token more often than necessary. */
export const LIVE_REFRESH_SKEW_S = 10 * 60;

export async function authedSession(skewS = ACCESS_SKEW_S): Promise<AuthedSession | null> {
  const cached = loadAuth();
  if (!cached) return null;

  // Fast path — reuse a still-valid access token: no refresh, no rotation, no lock. This is what
  // makes concurrent `inplan` processes safe (they never touch the single-use refresh token).
  const reused = await reuseCached(cached, skewS);
  if (reused) return reused;

  // Slow path — the cached token is missing/expiring: refresh (which rotates the refresh token)
  // ONLY under the exclusive lock, and cache the new access token so later callers take the fast
  // path. Load again inside the lock in case a concurrent process just refreshed.
  const locked = await withAuthLock<AuthedSession | null>(async ({ stillMine }) => {
    const auth = loadAuth();
    if (!auth) return null;
    const fresh = await reuseCached(auth, skewS); // a peer may have refreshed while we waited for the lock
    if (fresh) return fresh;

    // Fence the single-use rotation: if we were paused past staleMs and reclaimed, bail rather than
    // refresh alongside the new owner (that double-rotate revokes the token → logs the session out).
    // The caller re-checks the cache on non-acquisition, so returning null here is safely retryable.
    if (!stillMine()) return null;
    const db = newClient(auth);
    const { data, error } = await db.auth.refreshSession({ refresh_token: auth.refreshToken });
    if (error || !data.session) return null;

    // A refresh response with no rotated token is anomalous, and the old fallback (`|| auth.refreshToken`)
    // hid it in the most damaging way: rotation had almost certainly happened server-side, so we'd
    // persist a CONSUMED token, look healthy for the rest of the access token's hour, and then fail
    // every refresh forever. Treat it as a failed refresh instead — we keep the stored token untouched,
    // so a server that genuinely doesn't rotate stays usable on the next attempt.
    if (!data.session.refresh_token) {
      process.stderr.write("inplan: refresh returned no new refresh token; keeping the stored one and retrying rather than persisting a possibly-spent token\n");
      return null;
    }

    // Persist the rotated refresh token + the new access token (& expiry) so the fast path can
    // reuse it, and `whoami` has an identity without another round-trip.
    saveAuth({
      ...auth,
      refreshToken: data.session.refresh_token,
      accessToken: data.session.access_token,
      ...(data.session.expires_at ? { expiresAt: data.session.expires_at } : {}),
      ...(data.session.user?.email ? { email: data.session.user.email } : {}),
    });
    return { db, session: data.session };
  });
  if (locked.acquired) return locked.value;

  // Couldn't acquire the lock within the deadline (heavy contention). Do NOT refresh unlocked — the
  // holder is refreshing and about to persist. Re-check the cache with skew 0: accept the current
  // token as long as it isn't actually expired (it stays valid for up to the skew window), so
  // transient contention returns a usable session rather than a spurious null. Only a genuinely
  // expired/absent session yields null here — the one case where callers SHOULD say "run inplan
  // login". This keeps a long `wait` from aborting (and misreporting "logged out") on lock churn.
  return reuseCached(loadAuth() ?? cached, 0);
}

/** The signed-in user (id + email + display name), or null when not logged in / session invalid. */
export async function currentUser(): Promise<{ email?: string; id: string; name?: string } | null> {
  const s = await authedSession();
  if (!s) return null;
  const meta = (s.session.user.user_metadata ?? {}) as Record<string, unknown>;
  const name = [meta.full_name, meta.name, meta.user_name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return {
    id: s.session.user.id,
    ...(s.session.user.email ? { email: s.session.user.email } : {}),
    ...(name ? { name } : {}),
  };
}

/** A control channel + document store bound to one cloud document, authenticated
 *  as the logged-in user. */
export interface RemoteBackend {
  db: SupabaseClient;
  channel: ControlChannel;
  store: DocumentStore;
  /** The user's JWT — authenticates the collab websocket (for presence). */
  token: string;
}

/** Stable per-machine proposer client id (proposals v1): minted once, kept beside the sidecars
 *  (INPLAN_HOME-aware, so tests stay isolated). Losing it merely orphans a pending row — which
 *  stays reviewable — and the next park mints a new row. */
let cachedClientId: string | null = null;
function machineClientId(): string {
  // Process-lifetime cache: liveRemoteBackend re-mints the backend after token refreshes, and a
  // changing identity mid-process would orphan the pending row it just parked.
  if (cachedClientId) return cachedClientId;
  const p = join(dirname(sidecarRoot()), "proposer-client-id");
  try {
    const v = readFileSync(p, "utf8").trim();
    if (v) return (cachedClientId = v);
  } catch {
    /* mint below */
  }
  const v = mintProposalId();
  try {
    mkdirSync(dirname(p), { recursive: true });
    // Exclusive create: two processes racing the first mint must converge on ONE identity —
    // last-writer-wins would leave the loser's future rows invisible to its own lookups.
    writeFileSync(p, v, { flag: "wx" });
  } catch {
    try {
      const w = readFileSync(p, "utf8").trim();
      if (w) return (cachedClientId = w); // the race winner's id
    } catch {
      /* unwritable home: an ephemeral id still works for this process (cached above) */
    }
  }
  return (cachedClientId = v);
}

/**
 * Bind an authenticated client to one cloud document. Returns null when not
 * logged in (the caller prints "run `inplan login`").
 */
export async function remoteBackend(docId: string, consumerId = "cli-agent", skewS?: number): Promise<RemoteBackend | null> {
  const s = await authedSession(skewS);
  if (!s) return null;
  return {
    db: s.db,
    channel: new SupabaseControlChannel(s.db, docId, consumerId),
    // The CLI proposes as the signed-in USER on this MACHINE: RLS scopes user-kind rows, and the
    // stable client id keeps two of the same human's machines from superseding each other.
    store: new SupabaseDocumentStore(s.db, docId, { kind: "user", userId: s.session.user.id, clientId: machineClientId() }),
    token: s.session.access_token,
  };
}

/** A doc backend that transparently re-mints its authenticated client before the access token
 *  expires. A long `wait --remote` (the human idles past the ~1h JWT lifetime) otherwise keeps
 *  polling a fixed client whose token has expired — its reads 401 and the wait silently stalls,
 *  never seeing the user's turn. Re-minting runs through {@link remoteBackend}→{@link authedSession}
 *  (the lock-coordinated, refresh-token-persisting path), so it NEVER rotates the single-use token
 *  off-lock — which is exactly the race `autoRefreshToken:false` closes. Every channel/store call
 *  first ensures a fresh inner backend; between re-mints (≈ once per token lifetime) the cached one
 *  is reused, so the hot poll path creates no per-tick clients. */
export interface LiveRemoteBackend {
  /** A control channel that re-mints its client before expiry. NOTE: `channel.subscribe` is
   *  best-effort and unsupported before the first request lands (there's no inner client yet, so a
   *  pre-mint subscription is dropped); this backend is built for the POLL-based wait, which never
   *  subscribes. A future push-based consumer must not rely on subscribe here. */
  channel: ControlChannel;
  store: DocumentStore;
  /** The freshest access token (for presence/websocket re-auth), or null if the session is gone. */
  tokenNow(): string | null;
}
/** Backoff after a failed re-mint. The poll loop calls through here every `pollMs` (200ms), so an
 *  unthrottled retry replays the SAME single-use refresh token hundreds of times a minute — which is
 *  how GoTrue's reuse detection gets tripped and the whole token family revoked. A failing refresh
 *  must therefore get slower, not faster. */
const REFRESH_BACKOFF_BASE_MS = 1_000;
const REFRESH_BACKOFF_MAX_MS = 60_000;
/** Exported for the test that pins the schedule. */
export const refreshBackoffMs = (failures: number): number => Math.min(REFRESH_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), REFRESH_BACKOFF_MAX_MS);

export function liveRemoteBackend(docId: string, consumerId = "cli-agent"): LiveRemoteBackend {
  let inner: RemoteBackend | null = null;
  let expiresAt = 0; // the cached inner's access-token expiry (unix seconds)
  let inflight: Promise<RemoteBackend | null> | null = null; // the single in-progress re-mint, if any
  let failures = 0; // consecutive failed re-mints, driving the backoff
  let retryAfterMs = 0; // epoch ms before which we must NOT touch the refresh token again
  const fresh = async (): Promise<RemoteBackend | null> => {
    const now = Math.floor(Date.now() / 1000);
    // Refresh well BEFORE expiry (10 min, not 2) so a failure has a real retry budget instead of one
    // shot at the cliff.
    if (inner && expiresAt - now > LIVE_REFRESH_SKEW_S) return inner; // cached token still valid — reuse
    // Cooling off after a failure: serve the cached client while its token is genuinely unexpired,
    // and otherwise report unavailable WITHOUT another rotation attempt.
    if (Date.now() < retryAfterMs && !inflight) return inner && expiresAt > now ? inner : null;
    // Coalesce concurrent re-mints into ONE refresh: every channel/store call routes through here, so
    // without this several could each acquire the lock and rotate the refresh token in series. A
    // re-mint goes through remoteBackend()→authedSession(), which re-reads auth.json INSIDE the lock —
    // so it always starts from the freshest persisted token even if another process just rotated it.
    inflight ??= remoteBackend(docId, consumerId, LIVE_REFRESH_SKEW_S)
      .then((b) => {
        if (b) {
          failures = 0;
          retryAfterMs = 0;
          inner = b;
          // Trust the persisted expiry; if a session somehow carried none, assume a short validity so
          // we reuse rather than re-mint on every call, while still re-checking soon.
          expiresAt = loadAuth()?.expiresAt ?? now + 300;
          return b;
        }
        // Re-mint failed. Keep the last-good client ONLY for a genuinely transient failure — i.e. we're
        // still logged in (creds present) AND its token hasn't expired — so a brief network blip
        // doesn't drop a valid session. Otherwise (another process logged out ⇒ no creds, or the token
        // expired) DISCARD it: clear inner/expiresAt so tokenNow()/subscribe(), which bypass need(),
        // can't keep serving a stale/expired/revoked client, and callers get a clean "unavailable".
        failures += 1;
        retryAfterMs = Date.now() + refreshBackoffMs(failures);
        const stillLoggedIn = loadAuth() !== null;
        if (stillLoggedIn && inner && expiresAt > Math.floor(Date.now() / 1000)) return inner;
        inner = null;
        expiresAt = 0;
        return null;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  const need = async (): Promise<RemoteBackend> => {
    const b = await fresh();
    if (!b) throw new Error("inplan: not logged in (or session expired) — run `inplan login`");
    return b;
  };
  const channel: ControlChannel = {
    append: async (e, o) => (await need()).channel.append(e, o),
    readSince: async (c) => (await need()).channel.readSince(c),
    // The poll-based wait never subscribes; delegate best-effort to the current inner (a re-mint
    // doesn't migrate an active subscription — not needed on this path).
    subscribe: (cb) => inner?.channel.subscribe(cb) ?? (() => {}),
    getCursor: async () => (await need()).channel.getCursor(),
    setCursor: async (s) => (await need()).channel.setCursor(s),
    claimLock: async (t) => (await need()).channel.claimLock(t),
    isSuperseded: async (t) => (await need()).channel.isSuperseded(t),
    presence: async (sinceMs?: number) => (await need()).channel.presence(sinceMs),
  };
  const store: DocumentStore = {
    loadDoc: async () => (await need()).store.loadDoc(),
    saveDoc: async (c) => (await need()).store.saveDoc(c),
    getCanonical: async () => (await need()).store.getCanonical(),
    setCanonical: async (c) => (await need()).store.setCanonical(c),
    createProposal: async (i) => (await need()).store.createProposal(i),
    myPendingProposal: async () => (await need()).store.myPendingProposal(),
    getProposal: async (id) => (await need()).store.getProposal(id),
    withdrawProposal: async (id) => (await need()).store.withdrawProposal(id),
    decideProposal: async (id, st) => (await need()).store.decideProposal(id, st),
    backup: async (c, m) => (await need()).store.backup(c, m),
  };
  return { channel, store, tokenNow: () => inner?.token ?? null };
}
