// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rendezvous login (cliLogin.ts): a cloud session brokers the browser handoff so it works
// where the old loopback couldn't — coding agents and cross-machine CLIs. These tests drive the
// full client flow against a scripted fetch: create → poll → sealed completion → credentials,
// the 30 s "browser never opened" nudge, foreground timeout vs session expiry (sidecar survives
// the former, is cleared by the latter), and the sealing round-trip (the test seals exactly the
// way the /cli-auth page does, so parameter drift between the two halves fails here).

import { webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LoginSessionExpiredError,
  createLoginSession,
  loadPendingLogin,
  pendingLoginPath,
  pollLoginSession,
  rendezvousLogin,
  type PendingLogin,
} from "../src/cliLogin";

const subtle = webcrypto.subtle;
const SESSION = "11111111-2222-4333-8444-555555555555";
const payload = { url: "https://proj.supabase.co", anon: "anon-key", refresh: "refresh-token", email: "a@b.co" };

/** The CLI public key rides the URL fragment (never server logs) — parse it the way the page does. */
const pubOf = (url: string) => decodeURIComponent(url.split("#pub=")[1]!);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-login-"));
  process.env.INPLAN_HOME = home;
});
afterEach(() => {
  delete process.env.INPLAN_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Seal `payload` to the CLI's public key EXACTLY the way the /cli-auth page does
 *  (ECDH P-256 → HKDF-SHA256(salt=∅, info="inplan cli-login v1") → AES-256-GCM). */
async function sealLikeThePage(pubB64: string, data: unknown): Promise<{ epk: string; iv: string; ct: string }> {
  const cliPub = await subtle.importKey("spki", Buffer.from(pubB64, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const shared = await subtle.deriveBits({ name: "ECDH", public: cliPub }, eph.privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("inplan cli-login v1") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(data)));
  const epk = await subtle.exportKey("spki", eph.publicKey);
  return { epk: Buffer.from(epk).toString("base64"), iv: Buffer.from(iv).toString("base64"), ct: Buffer.from(ct).toString("base64") };
}

const res = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

/** A scripted server: POST create returns SESSION; each GET poll shifts the next scripted reply
 *  (an exhausted script answers 404, the server's "unknown or expired session"). */
function fakeServer(polls: Array<() => Promise<unknown> | unknown>, expiresInSec = 600) {
  const seen: string[] = [];
  const polledTokens: string[] = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method !== "POST") polledTokens.push(init?.headers?.["x-inplan-poll-token"] ?? "");
    if (init?.method === "POST" && url.endsWith("/api/v1/cli-login")) return res(200, { sessionId: SESSION, pollToken: "poll-tok", expiresInSec });
    const next = polls.shift();
    if (!next) return res(404, { error: "unknown or expired session" });
    return res(200, await next());
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, polledTokens };
}

/** Deterministic clock: sleep() advances it, so poll cadence and deadlines are exact. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

const OPTS = { apiBase: "http://hub.test", webOrigin: "https://web.test" };

describe("createLoginSession", () => {
  it("mints a session, builds the /cli-auth URL, and persists a resumable sidecar", async () => {
    const { fetchImpl, seen } = fakeServer([]);
    const c = clock();
    const pending = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    expect(seen).toEqual(["POST http://hub.test/api/v1/cli-login"]); // exactly one create, right route
    expect(pending.sessionId).toBe(SESSION);
    expect(pending.url).toMatch(new RegExp(`^https://web\\.test/cli-auth\\?session=${SESSION}#pub=`)); // pub in the FRAGMENT — never in server logs
    expect(pending.expiresAt).toBe(600_000);
    expect(existsSync(pendingLoginPath())).toBe(true);
    expect(await loadPendingLogin(c.now())).toEqual(pending);
  });

  it("throws on a server error and leaves no sidecar", async () => {
    const fetchImpl = (async () => res(503, { error: "nope" })) as unknown as typeof fetch;
    await expect(createLoginSession({ ...OPTS, fetchImpl })).rejects.toThrow(/HTTP 503/);
    expect(existsSync(pendingLoginPath())).toBe(false);
  });

  it("creates a never-existed base dir owner-only (0o700) rather than ENOENT on the lock", async () => {
    // First-ever run: the base dir doesn't exist. The sidecar lock must not ENOENT, and the dir —
    // which will hold the refresh token — must be created owner-only.
    process.env.INPLAN_HOME = join(home, "never-run", ".inplan");
    const { fetchImpl } = fakeServer([]);
    await createLoginSession({ ...OPTS, fetchImpl, now: clock().now });
    expect(existsSync(pendingLoginPath())).toBe(true);
    if (process.platform !== "win32") expect(statSync(process.env.INPLAN_HOME).mode & 0o777).toBe(0o700);
  });
});

describe("pollLoginSession", () => {
  it("completes: pending → opened → sealed handoff → credentials, sidecar cleared", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const pub = pubOf(pending.url);
    const { fetchImpl } = fakeServer([
      () => ({ status: "pending" }),
      () => ({ status: "opened" }),
      async () => ({ status: "completed", ...(await sealLikeThePage(pub, payload)) }),
    ]);
    const auth = await pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep });
    expect(auth).toEqual({ url: payload.url, anonKey: payload.anon, refreshToken: payload.refresh, email: payload.email });
    expect(existsSync(pendingLoginPath())).toBe(false); // single-use — a resume must not replay it
  });

  it("every poll carries the CLI-only token in the unlogged header (the URL alone can't claim)", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    expect(pending.pollToken).toBe("poll-tok");
    const pub = pubOf(pending.url);
    const srv = fakeServer([() => ({ status: "opened" }), async () => ({ status: "completed", ...(await sealLikeThePage(pub, payload)) })]);
    await pollLoginSession(pending, { fetchImpl: srv.fetchImpl, now: c.now, sleep: c.sleep });
    expect(srv.polledTokens).toEqual(["poll-tok", "poll-tok"]);
  });

  it("nudges exactly once when the page never acked `opened` within 30 s", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const pub = pubOf(pending.url);
    const polls: Array<() => Promise<unknown> | unknown> = Array.from({ length: 20 }, () => () => ({ status: "pending" }));
    polls.push(async () => ({ status: "completed", ...(await sealLikeThePage(pub, payload)) }));
    const { fetchImpl } = fakeServer(polls);
    const onNudge = vi.fn();
    await pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep, onNudge });
    expect(onNudge).toHaveBeenCalledTimes(1);
  });

  it("does NOT nudge when the page acked `opened` promptly (slow sign-in, browser fine)", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const pub = pubOf(pending.url);
    const polls: Array<() => Promise<unknown> | unknown> = Array.from({ length: 20 }, () => () => ({ status: "opened" }));
    polls.push(async () => ({ status: "completed", ...(await sealLikeThePage(pub, payload)) }));
    const { fetchImpl } = fakeServer(polls);
    const onNudge = vi.fn();
    await pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep, onNudge });
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("foreground timeout keeps the sidecar (the NEXT invocation resumes the login)", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const { fetchImpl } = fakeServer(Array.from({ length: 200 }, () => () => ({ status: "pending" })));
    await expect(pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep, timeoutMs: 10_000 })).rejects.toThrow(/timed out/);
    expect(existsSync(pendingLoginPath())).toBe(true);
    expect(await loadPendingLogin(c.now())).toEqual(pending);
  });

  it("server-side 404 (expired/claimed) throws LoginSessionExpiredError and clears the sidecar", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const { fetchImpl } = fakeServer([]); // no scripted polls → 404
    await expect(pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep })).rejects.toThrow(LoginSessionExpiredError);
    expect(existsSync(pendingLoginPath())).toBe(false);
  });

  it("local expiry throws LoginSessionExpiredError before ever fetching", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    c.set(700_000); // past expiresAt
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep })).rejects.toThrow(LoginSessionExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(pendingLoginPath())).toBe(false);
  });

  it("a handoff sealed to the WRONG key is terminal: sidecar cleared, expiry-class error", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const otherPub = Buffer.from(await subtle.exportKey("spki", kp.publicKey)).toString("base64");
    const { fetchImpl } = fakeServer([async () => ({ status: "completed", ...(await sealLikeThePage(otherPub, payload)) })]);
    // The claim-once GET consumed the row, so this session can never complete — it must read as
    // an expiry (start fresh), not as a transient failure the caller would keep resuming.
    await expect(pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep })).rejects.toThrow(LoginSessionExpiredError);
    expect(existsSync(pendingLoginPath())).toBe(false);
  });
});

describe("pollLoginSession — resilience", () => {
  it("tolerates transient transport failures (retries like a 5xx; the deadline bounds the wait)", async () => {
    const c = clock();
    const { fetchImpl: createFetch } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl: createFetch, now: c.now });
    const pub = pubOf(pending.url);
    let calls = 0;
    const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (init?.method === "POST") return res(200, { sessionId: SESSION, pollToken: "poll-tok", expiresInSec: 600 });
      calls++;
      if (calls <= 2) throw new TypeError("fetch failed"); // DNS blip / dropped connection
      return res(200, { status: "completed", ...(await sealLikeThePage(pub, payload)) });
    }) as unknown as typeof fetch;
    const auth = await pollLoginSession(pending, { fetchImpl, now: c.now, sleep: c.sleep });
    expect(auth.refreshToken).toBe(payload.refresh);
    expect(calls).toBe(3); // two failures retried, third answered
  });

  it("normalizes a bogus server TTL (NaN/negative) instead of minting a never-expiring sidecar", async () => {
    const c = clock();
    for (const bad of [Number.NaN, -5] as number[]) {
      const { fetchImpl } = fakeServer([], bad);
      const pending = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
      expect(pending.expiresAt).toBe(c.now() + 600_000); // default TTL, still expirable
    }
  });
});

describe("createLoginSession — concurrency", () => {
  it("a second concurrent create adopts the existing pending login instead of clobbering it", async () => {
    const c = clock();
    const { fetchImpl } = fakeServer([]);
    const first = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    // Second invocation while the first is still valid: same session comes back — the first
    // command's printed URL stays resumable (its private key was NOT overwritten).
    const second = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    expect(second).toEqual(first);
  });

  it("a stale leftover sidecar is replaced, not adopted", async () => {
    const c = clock();
    const { fetchImpl } = fakeServer([]);
    const first = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    c.set(700_000); // past the first session's expiry
    const { fetchImpl: freshFetch } = fakeServer([]);
    const second = await createLoginSession({ ...OPTS, fetchImpl: freshFetch, now: c.now });
    expect(second.sessionId).toBe(SESSION);
    expect(second.expiresAt).toBe(700_000 + 600_000);
    expect(second).not.toEqual(first);
  });
});

describe("loadPendingLogin", () => {
  it("returns null (and clears) an expired sidecar", async () => {
    const c = clock();
    const { fetchImpl } = fakeServer([]);
    await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    expect(await loadPendingLogin(600_001)).toBeNull();
    expect(existsSync(pendingLoginPath())).toBe(false);
  });

  it("returns null for a malformed sidecar", async () => {
    const c = clock();
    const { fetchImpl } = fakeServer([]);
    const pending = await createLoginSession({ ...OPTS, fetchImpl, now: c.now });
    writeFileSync(pendingLoginPath(), JSON.stringify({ ...pending, privateKeyPkcs8: 42 }));
    expect(await loadPendingLogin(c.now())).toBeNull();
    expect(existsSync(pendingLoginPath())).toBe(false);
  });
});

describe("rendezvousLogin", () => {
  it("opens the browser at the session URL, reports it, and completes inline", async () => {
    const c = clock();
    let pub = "";
    const { fetchImpl } = fakeServer([
      () => ({ status: "opened" }),
      async () => ({ status: "completed", ...(await sealLikeThePage(pub, payload)) }),
    ]);
    const open = vi.fn((u: string) => void (pub = pubOf(u)));
    const onUrl = vi.fn();
    const auth = await rendezvousLogin({ ...OPTS, fetchImpl, now: c.now, sleep: c.sleep, open, onUrl });
    expect(open).toHaveBeenCalledTimes(1);
    expect(onUrl).toHaveBeenCalledWith(expect.stringContaining("https://web.test/cli-auth?session="));
    expect(auth.refreshToken).toBe(payload.refresh);
  });
});

describe("pending sidecar shape", () => {
  it("never stores credentials — only the session + the private key that unlocks the handoff", async () => {
    const { fetchImpl } = fakeServer([]);
    const pending: PendingLogin = await createLoginSession({ ...OPTS, fetchImpl, now: clock().now });
    expect(JSON.stringify(pending)).not.toContain("refresh-token");
    expect(Object.keys(pending).sort()).toEqual(["apiBase", "expiresAt", "pollToken", "privateKeyPkcs8", "sessionId", "url"]);
  });
});
