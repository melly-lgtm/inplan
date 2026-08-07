// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI ⇄ cloud authentication. A logged-in human stores a long-lived refresh
// token in `~/.inplan/auth.json`; the CLI exchanges it for a short-lived JWT and
// drives a cloud document under that user's identity (RLS applies — the user
// must belong to the document's org). The service-role key is NEVER used here:
// the local CLI runs as the human, the same as the browser SPA.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { ControlChannel, DocumentStore } from "@inplan/core";
import { SupabaseControlChannel, SupabaseDocumentStore } from "@inplan/backend-supabase";

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
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
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
const LOCK_WAIT_MS = 10_000; // give up waiting after this and proceed best-effort (never deadlock)
const LOCK_STALE_MS = 15_000; // a lock older than this is assumed abandoned (crashed holder) and stolen

function lockDir(): string {
  return join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "auth.lock");
}

async function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = lockDir();
  mkdirSync(process.env.INPLAN_HOME || join(homedir(), ".inplan"), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock); // atomic create — fails if another holder exists
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true }); // steal an abandoned lock
          continue;
        }
      } catch {
        continue; // the lock vanished between stat and now — retry acquiring
      }
      await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 40)));
    }
  }
  try {
    return await fn(); // proceed even if unacquired (best-effort) — a held lock is the common case
  } finally {
    if (held) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Exchange the stored refresh token for an authenticated client. Persists the
 * rotated refresh token (and the session's email, for display) back to
 * `auth.json` so the next invocation starts fresh. Returns null when not logged
 * in or the session can't be refreshed (callers print "run `inplan login`").
 */
/** Refresh a full minute before expiry so a reused token never lands on a just-expired boundary. */
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
 *  Returns null if there's no usable cached token or it's within the expiry skew. */
async function reuseCached(auth: AuthFile): Promise<AuthedSession | null> {
  if (!auth.accessToken || !auth.expiresAt) return null;
  if (auth.expiresAt - Math.floor(Date.now() / 1000) <= ACCESS_SKEW_S) return null;
  const db = newClient(auth);
  // setSession only decodes+stores when the access token is unexpired (no network call, no
  // rotation). We've already checked expiry, so this is purely local.
  const { data, error } = await db.auth.setSession({ access_token: auth.accessToken, refresh_token: auth.refreshToken });
  return error || !data.session ? null : { db, session: data.session };
}

export async function authedSession(): Promise<AuthedSession | null> {
  const cached = loadAuth();
  if (!cached) return null;

  // Fast path — reuse a still-valid access token: no refresh, no rotation, no lock. This is what
  // makes concurrent `inplan` processes safe (they never touch the single-use refresh token).
  const reused = await reuseCached(cached);
  if (reused) return reused;

  // Slow path — the cached token is missing/expiring: refresh (which rotates the refresh token)
  // under a cross-process lock, and cache the new access token so the next callers take the fast
  // path. Load again inside the lock in case a concurrent process just refreshed.
  return withAuthLock(async () => {
    const auth = loadAuth();
    if (!auth) return null;
    const fresh = await reuseCached(auth); // a peer may have refreshed while we waited for the lock
    if (fresh) return fresh;

    const db = newClient(auth);
    const { data, error } = await db.auth.refreshSession({ refresh_token: auth.refreshToken });
    if (error || !data.session) return null;

    // Persist the rotated refresh token + the new access token (& expiry) so the fast path can
    // reuse it, and `whoami` has an identity without another round-trip.
    saveAuth({
      ...auth,
      refreshToken: data.session.refresh_token || auth.refreshToken,
      accessToken: data.session.access_token,
      ...(data.session.expires_at ? { expiresAt: data.session.expires_at } : {}),
      ...(data.session.user?.email ? { email: data.session.user.email } : {}),
    });
    return { db, session: data.session };
  });
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

/**
 * Bind an authenticated client to one cloud document. Returns null when not
 * logged in (the caller prints "run `inplan login`").
 */
export async function remoteBackend(docId: string, consumerId = "cli-agent"): Promise<RemoteBackend | null> {
  const s = await authedSession();
  if (!s) return null;
  return {
    db: s.db,
    channel: new SupabaseControlChannel(s.db, docId, consumerId),
    store: new SupabaseDocumentStore(s.db, docId),
    token: s.session.access_token,
  };
}
