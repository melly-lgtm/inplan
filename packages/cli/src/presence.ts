// SPDX-License-Identifier: AGPL-3.0-or-later

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";
import { resolveHubUrl } from "./pluginGate";

// Presence must connect to the SAME collab hub the agent's edits target — use the shared resolver so
// the badge can't probe a different hub than where edits land.
const COLLAB_URL = resolveHubUrl();

/** Grace before reporting an unauthenticated presence channel. Long enough for a cold hub start +
 *  auth round-trip; short enough that the report lands while the human is still looking.
 *  Exported for the tests, so the assertions track the real grace period. */
export const AUTH_REPORT_DELAY_MS = 15_000;

/** One shared suffix so every presence warning says the same, load-bearing thing: this channel is
 *  COSMETIC. A silently dead presence connection has been misread as "sync is broken" before — a
 *  real agent session deleted its local work over exactly that (issue #88). */
const COSMETIC_NOTE = "cosmetic only; document edits sync on a separate channel";

export interface PresenceHandle {
  /** Tear down the awareness connection (call when the wait ends / the process exits). */
  destroy: () => void;
}

/** Build the token resolver for the long-lived presence connection: re-mint on each reconnect.
 *  The failure modes need OPPOSITE handling:
 *  - `mint` THROWS (network blip, lock contention) → transient: reuse the last good token, the
 *    session may well still be valid and presence must never break the wait;
 *  - `mint` returns NULL (signed out / refresh definitively failed) → throw: knowingly re-sending a
 *    stale or revoked token invites the hub's Unauthorized close — the permanent-silent-death
 *    path this fix exists to prevent. The rejection surfaces via the presence failure handlers. */
export function presenceTokenResolver(initial: string, mint: () => Promise<{ token: string } | null>): () => Promise<string> {
  let last = initial;
  return async () => {
    let fresh: { token: string } | null;
    try {
      fresh = await mint();
    } catch {
      // Transient — the last good token is the best available answer, but ONLY while it is still
      // unexpired: during a prolonged refresh outage, a long wait would otherwise re-send the same
      // expired JWT on every reconnect, a stale-token loop the hub can only answer with auth
      // failures. An opaque (non-JWT) token has no readable expiry and keeps the plain fallback.
      const exp = jwtExpMs(last);
      if (exp !== null && exp <= Date.now()) throw new Error("cached token expired during a refresh outage — presence token unavailable");
      return last;
    }
    if (!fresh) throw new Error("signed out — presence token unavailable");
    last = fresh.token;
    return last;
  };
}

/** Epoch-ms expiry from a JWT's payload, or null when unreadable (opaque/test tokens). */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Announce this local agent in a cloud doc's awareness room (Yjs presence), so
 * the web shows an "agent · your machine" badge while `wait --remote` is
 * attached. Agent attachment is **derived from live presence, not stored** —
 * disconnecting (the wait exiting) clears it. Best-effort: presence must never
 * break the wait, so any failure here is swallowed and the wait proceeds.
 *
 * `token` may be a resolver: this connection is LONG-lived (a wait can span hours and hub
 * restarts/deploys), and the provider re-resolves the token on every reconnect — a string frozen at
 * attach goes stale after the ~1h JWT expiry and every later reconnect would fail auth.
 *
 * Failures are surfaced, not just swallowed: hocuspocus reports a rejected token via
 * `onAuthenticationFailed`, but its fatal variant — an `Unauthorized` close — only logs to the
 * console and permanently stops reconnecting (`shouldConnect = false`). Rather than depend on those
 * internals, a one-shot timer reports "still not authenticated after the grace period", which
 * catches every silent-death variant the same way.
 */
export function announcePresence(docId: string, token: string | (() => Promise<string>), model?: string): PresenceHandle {
  try {
    const ydoc = new Y.Doc();
    // Node has no DOM WebSocket; hand the socket the `ws` polyfill.
    const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL, WebSocketPolyfill: WebSocket });
    // The did-not-authenticate check follows the CONNECTION lifecycle, not just attach: re-armed on
    // every (re)connect so a silent death at hour 2 — after a hub restart — is still reported, and
    // cleared on a successful auth so a slow-but-successful connect can't leave a false alarm as
    // the channel's last word (a "recovered" line corrects one that already fired).
    let reported = false;
    let authCheck: ReturnType<typeof setTimeout> | undefined;
    const armAuthCheck = (): void => {
      if (authCheck) clearTimeout(authCheck);
      authCheck = setTimeout(() => {
        if (!provider.isAuthenticated) {
          reported = true;
          process.stderr.write(`inplan: presence badge channel did not authenticate — ${COSMETIC_NOTE}\n`);
        }
      }, AUTH_REPORT_DELAY_MS);
      authCheck.unref?.(); // a cosmetic check must never keep the process alive
    };
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docId,
      document: ydoc,
      token,
      onOpen: () => armAuthCheck(), // every (re)connect gets its own grace window
      onAuthenticated: () => {
        if (authCheck) clearTimeout(authCheck);
        if (reported) {
          reported = false;
          process.stderr.write(`inplan: presence badge authenticated after all — ${COSMETIC_NOTE}\n`);
        }
      },
      onAuthenticationFailed: ({ reason }) => process.stderr.write(`inplan: presence badge auth failed (${reason}) — ${COSMETIC_NOTE}\n`),
    });
    armAuthCheck(); // attach-time arm: covers a connection that never even opens
    // CROSS-REPO CONTRACT: this exact shape — {kind:"agent", agentLocation:"local", model?} — is
    // read verbatim by two places in the proprietary `inplan-cloud` repo: the web's
    // computeAgent() in packages/web/src/supabaseApi.ts (drives the connected-agent badge +
    // Finish-turn availability) and the collab server's noteAwareness() in
    // packages/collab/src/agentTrigger.ts (makes the managed cloud agent stand down while a local
    // CLI holds the turn). There is no shared type across the AGPL/cloud boundary, so a field
    // rename on either side breaks the OTHER side silently — this whole call is best-effort and
    // swallows failures by design. If you change this shape, grep both consumers first.
    provider.awareness?.setLocalStateField("inplanPresence", { kind: "agent", agentLocation: "local", ...(model ? { model } : {}) });
    return {
      destroy: () => {
        if (authCheck) clearTimeout(authCheck);
        try {
          provider.destroy();
          socket.destroy();
          ydoc.destroy();
        } catch {
          /* best-effort teardown */
        }
      },
    };
  } catch {
    return { destroy: () => {} };
  }
}
