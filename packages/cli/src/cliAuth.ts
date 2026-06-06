// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI ⇄ cloud authentication. A logged-in human stores a long-lived refresh
// token in `~/.inplan/auth.json`; the CLI exchanges it for a short-lived JWT and
// drives a cloud document under that user's identity (RLS applies — the user
// must belong to the document's org). The service-role key is NEVER used here:
// the local CLI runs as the human, the same as the browser SPA.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      return { url: raw.url, anonKey: raw.anonKey, refreshToken: raw.refreshToken, ...(raw.email ? { email: raw.email } : {}) };
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

/**
 * Exchange the stored refresh token for an authenticated client. Persists the
 * rotated refresh token (and the session's email, for display) back to
 * `auth.json` so the next invocation starts fresh. Returns null when not logged
 * in or the session can't be refreshed (callers print "run `inplan login`").
 */
export async function authedSession(): Promise<AuthedSession | null> {
  const auth = loadAuth();
  if (!auth) return null;

  const db = createClient(auth.url, auth.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: realtimeTransport,
  });
  const { data, error } = await db.auth.refreshSession({ refresh_token: auth.refreshToken });
  if (error || !data.session) return null;

  // Refresh tokens rotate; persist the new one (+ the email label) so we never
  // reuse a spent token and `whoami` has an identity without another round-trip.
  const rotated = data.session.refresh_token || auth.refreshToken;
  const email = data.session.user?.email ?? auth.email;
  if (rotated !== auth.refreshToken || email !== auth.email) {
    saveAuth({ ...auth, refreshToken: rotated, ...(email ? { email } : {}) });
  }
  return { db, session: data.session };
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
