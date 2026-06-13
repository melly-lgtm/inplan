// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the interactive browser login handoff: the one-shot loopback listener accepts the
// /cli-auth page's POST (matching state), rejects a mismatched state, and times out cleanly.
// The "browser" is simulated by a fetch from the injected `open` callback — no real browser.

import { describe, expect, it } from "vitest";
import { browserLogin } from "../src/cliLogin";

/** Parse port + state out of the handoff URL the CLI would open. */
function parse(url: string): { port: string; state: string } {
  const u = new URL(url);
  return { port: u.searchParams.get("port")!, state: u.searchParams.get("state")! };
}

/** POST a JSON body to the loopback /cb the way the web page does. */
async function postCb(port: string, body: unknown): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/cb`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://inplan.ai" },
    body: JSON.stringify(body),
  });
  return r.status;
}

describe("browserLogin", () => {
  it("resolves with the credentials the page hands back over the loopback", async () => {
    const auth = await browserLogin({
      timeoutMs: 5000,
      open: (url) => {
        const { port, state } = parse(url);
        void postCb(port, { state, url: "https://proj.supabase.co", anon: "anon-key", refresh: "rt-123", email: "a@b.com" });
      },
    });
    expect(auth).toEqual({ url: "https://proj.supabase.co", anonKey: "anon-key", refreshToken: "rt-123", email: "a@b.com" });
  });

  it("opens /cli-auth on the configured web origin with a port and a state nonce", async () => {
    let seen = "";
    const auth = await browserLogin({
      timeoutMs: 5000,
      webOrigin: "https://example.test/",
      open: (url) => {
        seen = url;
        const { port, state } = parse(url);
        void postCb(port, { state, url: "u", anon: "a", refresh: "r" });
      },
    });
    expect(seen).toMatch(/^https:\/\/example\.test\/cli-auth\?port=\d+&state=[0-9a-f]{32}$/);
    expect(auth.refreshToken).toBe("r"); // email is optional
    expect(auth.email).toBeUndefined();
  });

  it("ignores a mismatched-state POST and keeps waiting for the real one", async () => {
    const auth = await browserLogin({
      timeoutMs: 5000,
      open: (url) => {
        const { port, state } = parse(url);
        void (async () => {
          const bad = await postCb(port, { state: "wrong", url: "u", anon: "a", refresh: "evil" });
          expect(bad).toBe(403);
          // The real handoff still completes.
          await postCb(port, { state, url: "u", anon: "a", refresh: "good" });
        })();
      },
    });
    expect(auth.refreshToken).toBe("good");
  });

  it("rejects a malformed (non-JSON) body with 400 and keeps waiting", async () => {
    const auth = await browserLogin({
      timeoutMs: 5000,
      open: (url) => {
        const { port, state } = parse(url);
        void (async () => {
          const r = await fetch(`http://127.0.0.1:${port}/cb`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
          expect(r.status).toBe(400);
          await postCb(port, { state, url: "u", anon: "a", refresh: "ok" });
        })();
      },
    });
    expect(auth.refreshToken).toBe("ok");
  });

  it("rejects a non-string email (bad type guard) with 403 and keeps waiting", async () => {
    const auth = await browserLogin({
      timeoutMs: 5000,
      open: (url) => {
        const { port, state } = parse(url);
        void (async () => {
          const bad = await postCb(port, { state, url: "u", anon: "a", refresh: "r", email: {} });
          expect(bad).toBe(403);
          await postCb(port, { state, url: "u", anon: "a", refresh: "ok" });
        })();
      },
    });
    expect(auth.refreshToken).toBe("ok");
  });

  it("times out when the browser never responds", async () => {
    await expect(browserLogin({ timeoutMs: 150, open: () => {} })).rejects.toThrow(/timed out/);
  });
});
