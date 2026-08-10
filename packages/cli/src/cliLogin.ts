// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan login` — the cloud-rendezvous browser handoff. The CLI can't safely prompt for a
// password (and OAuth providers reject headless flows), so login is delegated to the web app's
// /cli-auth page. Historically the page POSTed the credentials to a one-shot 127.0.0.1 listener;
// that breaks exactly where agent workflows live — a coding agent only reads output when the
// process exits, and a CLI on a remote box can never receive a loopback POST from the human's
// browser on another machine. So the handoff now rides a short-lived CLOUD session instead
// (the collab server's /api/v1/cli-login routes):
//
//   1. Generate an ephemeral ECDH P-256 keypair; create a session; persist a pending-login
//      sidecar (0600) so a LATER invocation can finish what this one starts.
//   2. Send the human to /cli-auth?session=<id>&pub=<publicKey>. On load the page acks
//      `opened` (the cross-machine-safe "the browser really opened" signal — no ack within
//      30 s ⇒ tell the human to open the URL manually). After sign-in the page seals
//      {url, anon, refresh, email} to our public key (ECDH → HKDF-SHA256 → AES-256-GCM)
//      and posts the ciphertext to the session.
//   3. Poll the session; on completion decrypt locally (the server only ever stores bytes it
//      cannot read), persist the credentials, delete the sidecar. Sessions are single-use and
//      expire server-side in ~10 minutes.

import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthFile } from "./cliAuth";
import { resolveHubUrl } from "./pluginGate";

const subtle = webcrypto.subtle;

/** The web app origin that hosts /cli-auth. Overridable for self-hosted / dev. */
const DEFAULT_WEB_ORIGIN = process.env.INPLAN_WEB_URL || "https://inplan.ai";
/** HKDF domain separation — MUST match the /cli-auth page's sealer exactly. */
const HKDF_INFO = "inplan cli-login v1";
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 2_000;
/** No `opened` ack by this long ⇒ the browser likely never opened — nudge the human. */
const NUDGE_MS = 30_000;
/** Per-request bound: a stalled TCP connection must not hang the CLI silently (create) or stop
 *  the poll loop's deadline from ever being re-checked (poll). */
const REQUEST_TIMEOUT_MS = 15_000;

/** The collab server's HTTP base (same resolution as the plugin gate: ws(s) → http(s)). */
export function loginApiBase(): string {
  return resolveHubUrl().replace(/^ws/, "http").replace(/\/+$/, "");
}

export interface RendezvousDeps {
  fetchImpl?: typeof fetch;
  /** Launch the system browser at `url`. Overridable in tests. Default: OS opener. */
  open?: (url: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RendezvousLoginOptions extends RendezvousDeps {
  webOrigin?: string;
  apiBase?: string;
  /** How long the foreground command waits before giving up (the session itself lives longer,
   *  so a follow-up invocation can still resume it). */
  timeoutMs?: number;
  /** Notified with the handoff URL so the caller can print a manual fallback. */
  onUrl?: (url: string) => void;
  /** Fired once if the page hasn't acked `opened` within NUDGE_MS — "open the URL manually". */
  onNudge?: () => void;
}

/** A login this process started (or a previous one left behind): everything a later invocation
 *  needs to finish the handoff. The private key never leaves this machine. */
export interface PendingLogin {
  sessionId: string;
  /** Our ephemeral ECDH private key (PKCS#8, base64) — decrypts the sealed handoff. */
  privateKeyPkcs8: string;
  url: string;
  apiBase: string;
  expiresAt: number; // epoch ms
}

/** `~/.inplan/login-pending.json` — `INPLAN_HOME` overrides the base dir (tests). */
export function pendingLoginPath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "login-pending.json");
}

export function clearPendingLogin(): void {
  try {
    unlinkSync(pendingLoginPath());
  } catch {
    /* already gone */
  }
}

/** The pending login a previous invocation left behind, if it can still complete. An expired or
 *  unreadable sidecar is cleared and reads as absent. */
export function loadPendingLogin(now: number = Date.now()): PendingLogin | null {
  const path = pendingLoginPath();
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as PendingLogin;
    if (
      typeof p.sessionId !== "string" ||
      typeof p.privateKeyPkcs8 !== "string" ||
      typeof p.url !== "string" ||
      typeof p.apiBase !== "string" ||
      typeof p.expiresAt !== "number" ||
      p.expiresAt <= now
    ) {
      clearPendingLogin();
      return null;
    }
    return p;
  } catch {
    clearPendingLogin();
    return null;
  }
}

/** Create a rendezvous session + the sidecar that lets ANY later invocation finish it. */
export async function createLoginSession(opts: RendezvousLoginOptions = {}): Promise<PendingLogin> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const apiBase = opts.apiBase ?? loginApiBase();
  const webOrigin = (opts.webOrigin ?? DEFAULT_WEB_ORIGIN).replace(/\/$/, "");

  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = Buffer.from(await subtle.exportKey("spki", keys.publicKey)).toString("base64");
  const priv = Buffer.from(await subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");

  const res = await fetchImpl(`${apiBase}/api/v1/cli-login`, { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`could not start a sign-in session (HTTP ${res.status})`);
  const { sessionId, expiresInSec } = (await res.json()) as { sessionId: string; expiresInSec: number };
  if (typeof sessionId !== "string" || !sessionId) throw new Error("could not start a sign-in session (bad response)");

  const pending: PendingLogin = {
    sessionId,
    privateKeyPkcs8: priv,
    // `pub` rides the URL FRAGMENT so it never reaches server access logs (a log reader holding
    // session + pub could complete the session for their own account); the page reads it from
    // location.hash. Public key or not, keep the whole capability out of logs.
    url: `${webOrigin}/cli-auth?session=${encodeURIComponent(sessionId)}#pub=${encodeURIComponent(pub)}`,
    apiBase,
    // Guard against a bogus server TTL: NaN/Infinity/negative would make expiresAt a past
    // timestamp — or one that NEVER expires (NaN compares false forever), leaving a dead sidecar
    // that every later invocation resumes until the server 404s.
    expiresAt: now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 600) * 1000,
  };
  const path = pendingLoginPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pending, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync mode is ignored when the file pre-existed
  return pending;
}

/** Distinguishes "this session can never complete" (sidecar cleared; start fresh) from a
 *  foreground timeout (sidecar kept; a later invocation resumes). */
export class LoginSessionExpiredError extends Error {}

/**
 * Poll `pending` until the page posts the sealed handoff, then decrypt + return the credentials
 * (the sidecar is deleted on success — sessions are single-use). Throws LoginSessionExpiredError
 * when the session is gone server-side (also clears the sidecar), or a plain Error on foreground
 * timeout (the sidecar survives so the NEXT invocation picks the login up — the coding-agent loop).
 */
export async function pollLoginSession(pending: PendingLogin, opts: RendezvousLoginOptions = {}): Promise<AuthFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const nudgeAt = now() + NUDGE_MS;
  let nudged = false;

  while (true) {
    if (now() >= pending.expiresAt) {
      clearPendingLogin();
      throw new LoginSessionExpiredError("the sign-in link expired — run the command again for a fresh one");
    }
    if (now() >= deadline) throw new Error("login timed out — no response from the browser");

    let res: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      res = await fetchImpl(`${pending.apiBase}/api/v1/cli-login/${encodeURIComponent(pending.sessionId)}`, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Transient transport failure (DNS blip, dropped connection, a stalled request cut by the
      // per-request timeout): retry like a 5xx — the session is still valid, and the foreground
      // deadline above bounds the total wait. Only a 404 (below) ends the session for good.
      await sleep(POLL_MS);
      continue;
    }
    if (res.status === 404) {
      // Unknown/expired/already-claimed server-side — this pending login can never complete.
      clearPendingLogin();
      throw new LoginSessionExpiredError("the sign-in link expired — run the command again for a fresh one");
    }
    if (res.ok) {
      const body = (await res.json()) as { status?: string; epk?: string; iv?: string; ct?: string };
      if (body.status === "completed" && body.epk && body.iv && body.ct) {
        const auth = await unsealHandoff(pending.privateKeyPkcs8, { epk: body.epk, iv: body.iv, ct: body.ct });
        clearPendingLogin();
        return auth;
      }
      // Still pending after the nudge window with the page never even loading? Tell the human —
      // open() is fire-and-forget (a spawn "success" doesn't mean a browser appeared), so the
      // page's own `opened` ack is the only trustworthy signal, and it works cross-machine.
      if (!nudged && body.status === "pending" && now() >= nudgeAt) {
        nudged = true;
        opts.onNudge?.();
      }
    }
    await sleep(POLL_MS);
  }
}

/** The one-command human flow: create a session, open the browser, poll to completion inline. */
export async function rendezvousLogin(opts: RendezvousLoginOptions = {}): Promise<AuthFile> {
  const pending = await createLoginSession(opts);
  opts.onUrl?.(pending.url);
  (opts.open ?? openInBrowser)(pending.url);
  return pollLoginSession(pending, opts);
}

/** Best-effort: open `url` in the OS browser. Errors are swallowed — the URL is also
 *  printed so the user can open it by hand (and the 30 s no-`opened` nudge re-prompts). */
export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // A missing opener (headless/CI) surfaces as an async 'error' event, not a sync throw —
    // swallow it so it can't become an unhandled error and crash before the printed-URL fallback.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opener missing (headless/CI) — the printed URL is the fallback */
  }
}

/** Decrypt the page's sealed handoff: ECDH(P-256) → HKDF-SHA256(salt=∅, info=HKDF_INFO) →
 *  AES-256-GCM — the exact inverse of the page's `sealCliLogin`. */
async function unsealHandoff(privateKeyPkcs8: string, sealed: { epk: string; iv: string; ct: string }): Promise<AuthFile> {
  const privateKey = await subtle.importKey("pkcs8", Buffer.from(privateKeyPkcs8, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const epk = await subtle.importKey("spki", Buffer.from(sealed.epk, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64") }, aes, Buffer.from(sealed.ct, "base64"));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { url?: string; anon?: string; refresh?: string; email?: string };
  if (typeof parsed.url !== "string" || typeof parsed.anon !== "string" || typeof parsed.refresh !== "string") {
    throw new Error("sign-in handoff was malformed");
  }
  return { url: parsed.url, anonKey: parsed.anon, refreshToken: parsed.refresh, ...(parsed.email ? { email: parsed.email } : {}) };
}
