// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interactive `inplan login`: the browser handoff. The CLI can't safely prompt for a
// password (and OAuth providers reject headless flows), so login is delegated to the web
// app's /cli-auth page, exactly as the desktop app does. We spin up a one-shot
// 127.0.0.1 listener, open the browser at /cli-auth?port=<port>&state=<nonce>, and the page
// POSTs the project url/anon + the freshly-minted refresh token back over the loopback once a
// session exists. The token only ever crosses localhost; `state` is echoed back so a stray
// local request can't inject a session.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AuthFile } from "./cliAuth";

/** The web app origin that hosts /cli-auth. Overridable for self-hosted / dev. */
const DEFAULT_WEB_ORIGIN = process.env.INPLAN_WEB_URL || "https://inplan.ai";
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const MAX_BODY_BYTES = 64 * 1024; // a refresh token is small; cap to refuse junk.

export interface BrowserLoginOptions {
  /** Origin hosting /cli-auth (default https://inplan.ai or $INPLAN_WEB_URL). */
  webOrigin?: string;
  /** How long to wait for the browser handoff before giving up. */
  timeoutMs?: number;
  /** Launch the system browser at `url`. Overridable in tests. Default: OS opener. */
  open?: (url: string) => void;
  /** Notified with the handoff URL so the caller can print a manual fallback. */
  onUrl?: (url: string) => void;
}

/** The JSON the /cli-auth page POSTs back over the loopback once signed in. */
interface Handoff {
  state: string;
  url: string;
  anon: string;
  refresh: string;
  email?: string;
}

/** Best-effort: open `url` in the OS browser. Errors are swallowed — the URL is also
 *  printed so the user can open it by hand. */
function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* opener missing (headless/CI) — the printed URL is the fallback */
  }
}

function isHandoff(v: unknown): v is Handoff {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.state === "string" && typeof o.url === "string" && typeof o.anon === "string" && typeof o.refresh === "string";
}

/**
 * Run the browser login handoff and resolve with the credentials to persist. Rejects on
 * timeout or if the listener fails. The caller is responsible for `saveAuth` + identity.
 */
export function browserLogin(opts: BrowserLoginOptions = {}): Promise<AuthFile> {
  const webOrigin = (opts.webOrigin ?? DEFAULT_WEB_ORIGIN).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const open = opts.open ?? openInBrowser;
  const state = randomBytes(16).toString("hex");

  return new Promise<AuthFile>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    // CORS: the page lives on an https origin and fetches this http://127.0.0.1 listener, so a
    // JSON POST is preflighted. Echo the caller's Origin (the page) and allow the JSON content-type.
    const cors = (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || webOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
    };

    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "OPTIONS" && url.startsWith("/cb")) {
        cors(req, res);
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST" || !url.startsWith("/cb")) {
        res.writeHead(404).end();
        return;
      }
      cors(req, res);
      let body = "";
      let tooBig = false;
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) {
          res.writeHead(413).end();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (!isHandoff(parsed) || parsed.state !== state) {
          // Not our handoff (mismatched/missing state) — reject but keep listening; a stray
          // local request must not end the real flow.
          res.writeHead(403).end();
          return;
        }
        // Acknowledge so the page can show "you can close this tab", then finish.
        res.writeHead(200, { "content-type": "text/plain" }).end("inplan: signed in — you can close this tab.");
        const { url: projUrl, anon, refresh, email } = parsed;
        finish(() => resolve({ url: projUrl, anonKey: anon, refreshToken: refresh, ...(email ? { email } : {}) }));
      });
    });

    server.on("error", (err) => finish(() => reject(err)));

    const timer = setTimeout(() => finish(() => reject(new Error("login timed out — no response from the browser"))), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const target = `${webOrigin}/cli-auth?port=${port}&state=${state}`;
      opts.onUrl?.(target);
      open(target);
    });
  });
}
