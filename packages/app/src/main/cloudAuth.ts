// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

/** Cloud credentials captured from the browser handoff, ready to hand to `inplan login`. */
export interface CloudCredentials {
  url: string; // the Supabase project URL
  anon: string; // the Supabase anon key
  refresh: string; // the signed-in session's refresh token
  email?: string;
}

/** A started sign-in handoff: the URL to show, a promise that resolves with the captured
 *  credentials (or null on cancel/timeout), and a cancel hook. */
export interface CloudSignIn {
  authUrl: string;
  done: Promise<CloudCredentials | null>;
  cancel(): void;
}

/** The page the loopback serves once the handoff completes — shown in the in-app overlay's
 *  iframe (and in the system-browser tab for the OAuth path) just before it's dismissed. */
const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>inplan</title>
<style>html{font:16px/1.5 -apple-system,system-ui,sans-serif;color:#1c2b27;background:#f4f1ea}
body{display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem 2.5rem}
h1{font-size:1.25rem;margin:0 0 .35rem}p{margin:0;color:#5a6b65}</style>
<div class="card"><h1>You're signed in.</h1><p>Returning to inplan…</p></div>`;

/**
 * Browser-based cloud sign-in for the desktop app (RFC 8252 "native app" pattern, loopback
 * variant). The editor itself never speaks to Supabase — this only captures a refresh token
 * and hands it to the `inplan` CLI, which owns auth.
 *
 * This module owns just the loopback half: it starts a one-shot `127.0.0.1:<random>` listener
 * keyed by a random `state` and returns the `/cli-auth` URL to load. The renderer shows that
 * URL in an in-app modal overlay (an <iframe>); email/password completes inline, while OAuth
 * providers (which reject embedded frames) are popped to the system browser by the page's
 * `window.open` (routed to the OS browser by the main window's window-open handler). Whichever
 * surface finishes redirects to `/cb`; the refresh token only ever crosses localhost and the
 * echoed `state` is verified, so a stray local page can't complete the handoff.
 */
export function startCloudSignIn(cloudBase: string, timeoutMs = 5 * 60_000): Promise<CloudSignIn> {
  return new Promise((resolveStart) => {
    const state = randomBytes(16).toString("hex");
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveDone!: (result: CloudCredentials | null) => void;
    const done = new Promise<CloudCredentials | null>((res) => {
      resolveDone = res;
    });

    const finish = (result: CloudCredentials | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolveDone(result);
    };

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/cb") {
        res.writeHead(404);
        res.end();
        return;
      }
      const q = reqUrl.searchParams;
      const url = q.get("url");
      const anon = q.get("anon");
      const refresh = q.get("refresh");
      if (q.get("state") !== state || !url || !anon || !refresh) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Invalid sign-in callback.");
        return; // a stray/forged request must not end a live handoff
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DONE_HTML);
      finish({ url, anon, refresh, email: q.get("email") ?? undefined });
    });
    server.on("error", () => finish(null));

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const authUrl = `${cloudBase}/cli-auth?port=${port}&state=${encodeURIComponent(state)}`;
      timer = setTimeout(() => finish(null), timeoutMs);
      resolveStart({ authUrl, done, cancel: () => finish(null) });
    });
  });
}
