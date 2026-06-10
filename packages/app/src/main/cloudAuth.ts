// SPDX-License-Identifier: AGPL-3.0-or-later

import { BrowserWindow, shell } from "electron";
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

/** The page shown in the browser tab once the handoff completes (system-browser OAuth case;
 *  the embedded window is closed immediately, so it never lingers on this). */
const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>inplan</title>
<style>html{font:16px/1.5 -apple-system,system-ui,sans-serif;color:#1c2b27;background:#f4f1ea}
body{display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem 2.5rem}
h1{font-size:1.25rem;margin:0 0 .35rem}p{margin:0;color:#5a6b65}</style>
<div class="card"><h1>You're signed in.</h1><p>You can close this tab and return to inplan.</p></div>`;

/**
 * Browser-based cloud sign-in for the desktop app (RFC 8252 "native app" pattern, loopback
 * variant). The editor itself never speaks to Supabase — this only captures a refresh token
 * and hands it to the `inplan` CLI, which owns auth.
 *
 * Flow:
 *  1. Start a one-shot listener on `127.0.0.1:<random>` keyed by a random `state`.
 *  2. Open an embedded window to `${cloudBase}/cli-auth?port&state` for email/password.
 *     OAuth providers can't run in an embedded webview (Google blocks "disallowed_useragent"),
 *     so the page pops the system browser via `window.open`, which we route to the OS browser
 *     (`shell.openExternal`); whichever surface finishes redirects to our `/cb` with the token.
 *  3. Resolve with the credentials on a state-matched `/cb`, or `null` on cancel/timeout.
 *
 * The refresh token only ever crosses the loopback interface (localhost); `state` blocks a
 * rogue local page from completing someone else's handoff.
 */
export function startCloudSignIn(parent: BrowserWindow | null, cloudBase: string, timeoutMs = 5 * 60_000): Promise<CloudCredentials | null> {
  return new Promise((resolve) => {
    const state = randomBytes(16).toString("hex");
    let settled = false;
    let authWin: BrowserWindow | null = null;
    let oauthInFlight = false; // the user kicked OAuth out to the system browser
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: CloudCredentials | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* already closed */
      }
      const w = authWin;
      authWin = null; // null first so the 'closed' handler doesn't re-enter finish()
      if (w && !w.isDestroyed()) w.close();
      resolve(result);
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
        return; // do not settle — a stray/forged request must not end a live handoff
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DONE_HTML);
      finish({ url, anon, refresh, email: q.get("email") ?? undefined });
    });
    server.on("error", () => finish(null));

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const authUrl = `${cloudBase}/cli-auth?port=${port}&state=${encodeURIComponent(state)}`;
      authWin = new BrowserWindow({
        width: 460,
        height: 720,
        parent: parent ?? undefined,
        modal: !!parent, // a sheet attached to (and blocking) the editor window, not a free window
        resizable: false,
        minimizable: false,
        title: "Sign in to inplan.ai",
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      // OAuth providers block embedded webviews, so the page opens them with window.open —
      // route that to the system browser (it returns to /cb over the same loopback + state).
      authWin.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) {
          oauthInFlight = true;
          void shell.openExternal(url);
        }
        return { action: "deny" };
      });
      // Closing the window before any handoff = cancel. But once OAuth has moved to the system
      // browser, the user may close this window expecting to finish there — keep the listener
      // alive (until /cb or timeout) instead of cancelling.
      authWin.on("closed", () => {
        authWin = null;
        if (!oauthInFlight) finish(null);
      });
      void authWin.loadURL(authUrl);
    });

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
