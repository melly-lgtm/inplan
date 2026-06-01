// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI ⇄ cloud authentication. A logged-in human stores a long-lived refresh
// token in `~/.inplan/auth.json`; the CLI exchanges it for a short-lived JWT and
// drives a cloud document under that user's identity (RLS applies — the user
// must belong to the document's org). The service-role key is NEVER used here:
// the local CLI runs as the human, the same as the browser SPA.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ControlChannel, DocumentStore } from "@inplan/core";
import { SupabaseControlChannel, SupabaseDocumentStore } from "@inplan/backend-supabase";

/** Persisted CLI credentials. The anon key + URL identify the deployment; the
 *  refresh token is the user's session (rotated on each refresh). */
export interface AuthFile {
  url: string;
  anonKey: string;
  refreshToken: string;
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
      return { url: raw.url, anonKey: raw.anonKey, refreshToken: raw.refreshToken };
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

/** A control channel + document store bound to one cloud document, authenticated
 *  as the logged-in user. */
export interface RemoteBackend {
  db: SupabaseClient;
  channel: ControlChannel;
  store: DocumentStore;
}

/**
 * Exchange the stored refresh token for an authenticated client and bind it to a
 * cloud document. Persists the rotated refresh token back to `auth.json` so the
 * next invocation starts from a fresh token. Returns null when not logged in or
 * the session can't be refreshed (the caller prints "run `inplan login`").
 */
export async function remoteBackend(docId: string, consumerId = "cli-agent"): Promise<RemoteBackend | null> {
  const auth = loadAuth();
  if (!auth) return null;

  const db = createClient(auth.url, auth.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.refreshSession({ refresh_token: auth.refreshToken });
  if (error || !data.session) return null;

  // Refresh tokens rotate; persist the new one so we don't reuse a spent token.
  const rotated = data.session.refresh_token;
  if (rotated && rotated !== auth.refreshToken) {
    saveAuth({ ...auth, refreshToken: rotated });
  }

  return {
    db,
    channel: new SupabaseControlChannel(db, docId, consumerId),
    store: new SupabaseDocumentStore(db, docId),
  };
}
