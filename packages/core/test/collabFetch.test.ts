// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { resolveDesktopCollab, type LeaseClaims } from "../src/node";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
const lease = (exp: number): string => {
  const body = Buffer.from(JSON.stringify({ sub: "u1", plan: "pro", features: ["instant"], iat: 0, exp } satisfies LeaseClaims)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
};
const entry = (name: string, bytes: Buffer) => ({ name, sha384: createHash("sha384").update(bytes).digest("base64"), sig: sign(null, bytes, privateKey).toString("base64") });

const DESKTOP = Buffer.from("export const desktop = 1;\n");
const HUB = Buffer.from("export const hub = 1;\n");
const BUNDLE = "https://bundle.example/collab/";
const API = "https://collab.example";

// A fake fetch over a {url: {ok, json?, bytes?}} table.
function fakeFetch(table: Record<string, { ok: boolean; json?: unknown; bytes?: Buffer }>): typeof fetch {
  return (async (url: string) => {
    const hit = table[String(url)];
    if (!hit) return { ok: false, status: 404 } as Response;
    return {
      ok: hit.ok,
      status: hit.ok ? 200 : 500,
      json: async () => hit.json,
      arrayBuffer: async () => (hit.bytes ? hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) : new ArrayBuffer(0)),
    } as unknown as Response;
  }) as typeof fetch;
}

const manifest = { version: "v1", files: [entry("desktop.js", DESKTOP), entry("hub.js", HUB)] };
const happyTable = {
  [`${API}/api/v1/desktop-collab`]: { ok: true, json: { entitled: true, lease: lease(9_999_999_999_999), bundleUrl: BUNDLE } },
  [`${BUNDLE}manifest.json`]: { ok: true, json: manifest },
  [`${BUNDLE}desktop.js`]: { ok: true, bytes: DESKTOP },
  [`${BUNDLE}hub.js`]: { ok: true, bytes: HUB },
};

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
const cacheDir = () => (dir = mkdtempSync(join(tmpdir(), "inplan-collab-")));

describe("resolveDesktopCollab", () => {
  it("entitled online → fetches, verifies, caches, returns verified paths + lease", async () => {
    const r = await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cacheDir(), publicKey: pub, now: 1000, fetchImpl: fakeFetch(happyTable) });
    expect(r).not.toBeNull();
    expect(r!.version).toBe("v1");
    expect(r!.lease.plan).toBe("pro");
    expect(Object.keys(r!.files).sort()).toEqual(["desktop.js", "hub.js"]);
    expect(readFileSync(r!.files["hub.js"]!).toString()).toBe(HUB.toString());
  });

  it("server says entitled:false → null (and does not fall back to a stale cache)", async () => {
    const cd = cacheDir();
    // Prime a valid cache first.
    await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 1000, fetchImpl: fakeFetch(happyTable) });
    const r = await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 1000, fetchImpl: fakeFetch({ [`${API}/api/v1/desktop-collab`]: { ok: true, json: { entitled: false } } }) });
    expect(r).toBeNull();
  });

  it("offline (fetch throws) but cached lease still valid → returns the cached bundle", async () => {
    const cd = cacheDir();
    await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 1000, fetchImpl: fakeFetch(happyTable) });
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 2000, fetchImpl: offline });
    expect(r?.version).toBe("v1");
  });

  it("offline + cached lease expired → null", async () => {
    const cd = cacheDir();
    // Cache a lease that expires at 5000.
    const tbl = { ...happyTable, [`${API}/api/v1/desktop-collab`]: { ok: true, json: { entitled: true, lease: lease(5000), bundleUrl: BUNDLE } } };
    await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 1000, fetchImpl: fakeFetch(tbl) });
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 6000, fetchImpl: offline })).toBeNull();
  });

  it("tampered cached bundle file → null (re-verified on load)", async () => {
    const cd = cacheDir();
    const r = await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 1000, fetchImpl: fakeFetch(happyTable) });
    writeFileSync(r!.files["hub.js"]!, "evil()\n"); // tamper the cache
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cd, publicKey: pub, now: 2000, fetchImpl: offline })).toBeNull();
  });

  it("refuses to cache a bundle file whose signature doesn't match the baked key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const badEntry = { name: "hub.js", sha384: createHash("sha384").update(HUB).digest("base64"), sig: sign(null, HUB, other).toString("base64") };
    const tbl = {
      [`${API}/api/v1/desktop-collab`]: { ok: true, json: { entitled: true, lease: lease(9_999_999_999_999), bundleUrl: BUNDLE } },
      [`${BUNDLE}manifest.json`]: { ok: true, json: { version: "v2", files: [badEntry] } },
      [`${BUNDLE}hub.js`]: { ok: true, bytes: HUB },
    };
    expect(await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cacheDir(), publicKey: pub, now: 1000, fetchImpl: fakeFetch(tbl) })).toBeNull();
  });

  it("no public key (unconfigured build) → null without any fetch", async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: false } as Response; }) as unknown as typeof fetch;
    expect(await resolveDesktopCollab({ apiBase: API, token: "jwt", cacheDir: cacheDir(), publicKey: "", now: 1000, fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it("logged out (no token) + no cache → null", async () => {
    expect(await resolveDesktopCollab({ apiBase: API, token: null, cacheDir: cacheDir(), publicKey: pub, now: 1000, fetchImpl: fakeFetch(happyTable) })).toBeNull();
  });
});
