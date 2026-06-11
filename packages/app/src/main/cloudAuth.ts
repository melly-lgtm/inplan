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
 * surface finishes **POSTs** the credentials to `/cb` (the page reads them back, so the token
 * never rides in a URL/history — `127.0.0.1` is a Chromium "secure" origin, so an https page
 * can fetch it without a mixed-content block); the echoed `state` is verified, so a stray/forged
 * request can't complete the handoff. Resolves `null` if the loopback can't even bind (so the
 * caller never hangs).
 */
export function startCloudSignIn(cloudBase: string, timeoutMs = 5 * 60_000): Promise<CloudSignIn | null> {
  return new Promise((resolveStart) => {
    const state = randomBytes(16).toString("hex");
    let settled = false;
    let listening = false;
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

    // The page POSTs cross-origin (inplan.ai → 127.0.0.1), which is a CORS-preflighted request.
    const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/cb") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, CORS);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // bound the read; a real payload is tiny
      });
      req.on("end", () => {
        let creds: Partial<CloudCredentials> & { state?: string } = {};
        try {
          creds = JSON.parse(body || "{}");
        } catch {
          /* malformed → treated as invalid below */
        }
        const { state: echoed, url, anon, refresh, email } = creds;
        if (echoed !== state || !url || !anon || !refresh) {
          res.writeHead(400, { ...CORS, "content-type": "application/json" });
          res.end('{"ok":false}');
          return; // a stray/forged request must not end a live handoff
        }
        res.writeHead(200, { ...CORS, "content-type": "application/json" });
        res.end('{"ok":true}');
        finish({ url, anon, refresh, email: email ?? undefined });
      });
    });
    // Settle the OUTER promise too on a pre-listen bind failure, or the caller awaits forever.
    server.on("error", () => {
      finish(null);
      if (!listening) resolveStart(null);
    });

    server.listen(0, "127.0.0.1", () => {
      listening = true;
      const port = (server.address() as AddressInfo).port;
      const authUrl = `${cloudBase}/cli-auth?port=${port}&state=${encodeURIComponent(state)}`;
      timer = setTimeout(() => finish(null), timeoutMs);
      resolveStart({ authUrl, done, cancel: () => finish(null) });
    });
  });
}
