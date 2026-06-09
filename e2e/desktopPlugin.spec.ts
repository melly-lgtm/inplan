// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Entitled-path e2e for the desktop runtime-plugin loader (Stage 3c). Exercises the WHOLE
// runtime-fetched-code trust path end to end, against a THROWAWAY signing key + a locally-signed
// STUB plugin bundle (the open-core repo never ships any real plugin):
//
//   pre-seeded verified cache → main verifies the lease + each bundle file (Ed25519 + sha384 vs the
//   baked public key) → imports the main entry (start) → serves the renderer entry over the
//   privileged inplan-plugin: scheme → the renderer imports it under CSP → activate(session) → the
//   binding + extra mode it returns are merged onto the host api via setHostApi → the editor
//   advertises the plugin's mode.
//
// The online entitlement fetch is covered by the pluginFetch unit tests; here we drive the offline
// cache branch (no INPLAN_CLI ⇒ no token ⇒ the loader verifies + loads the cached bundle), which is
// the same verify→import→merge path the online branch funnels into.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const REPO = process.cwd();

// A throwaway Ed25519 keypair — the role INPLAN_LEASE_PRIVATE_KEY plays in prod. The public key is
// handed to the app via INPLAN_PLUGIN_PUBLIC_KEY (the runtime fallback when no key was baked at build).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Sign a lease exactly as the plugin server does: base64url(payload).base64url(ed25519 sig). */
function signLease(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}
/** A manifest entry: base64 sha384 + base64 ed25519 sig over the file bytes (≡ sign-bundle.mjs). */
const entry = (name: string, bytes: Buffer): { name: string; sha384: string; sig: string } => ({
  name,
  sha384: createHash("sha384").update(bytes).digest("base64"),
  sig: sign(null, bytes, privateKey).toString("base64"),
});

// Stub plugin entries (the role of the real plugin build). Self-contained ESM with no imports — the
// renderer entry runs in the browser, the main entry in node. They satisfy the loader's structural
// contract (start → session; activate(session) → capabilities) without doing any real work.
const MAIN_JS = `export async function start(file){return{session:"sess:"+file,stop:async()=>{}};}\n`;
const RENDERER_JS = `const MODE={id:"instant",labelKey:"topbar.instant",locksEditor:false,wake:"any-action",autosaveKind:"canonical",autosaveDelayMs:5000,applyKind:"canonical",showFinishTurn:false};
export function activate(session){globalThis.__E2E_PLUGIN={active:true,session};return{binding:{extensions:[],getText:()=>""},commentStore:undefined,extraModes:[MODE],dispose:()=>{}};}\n`;

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "inplan-plugin-e2e-"));
  const home = join(dir, "home");
  const version = "e2e-v1";
  const vdir = join(home, "plugin-cache", version);
  mkdirSync(vdir, { recursive: true });

  const mainJs = Buffer.from(MAIN_JS);
  const rendererJs = Buffer.from(RENDERER_JS);
  writeFileSync(join(vdir, "main.js"), mainJs);
  writeFileSync(join(vdir, "renderer.js"), rendererJs);
  // Mirror fetchAndCache: mark the cache dir as ESM so Node import()s the .js bundle files as modules.
  writeFileSync(join(vdir, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(vdir, "manifest.json"),
    JSON.stringify({ version, files: [entry("main.js", mainJs), entry("renderer.js", rendererJs)], entries: { main: "main.js", renderer: "renderer.js" } }),
  );
  writeFileSync(join(vdir, "lease.txt"), signLease({ sub: "u1", plan: "pro", features: ["instant"], iat: 0, exp: 1e15 }));
  writeFileSync(join(home, "plugin-cache", "current.txt"), version);
  // Skip the first-run tour so we mount straight into the real editor (the plugin merge surviving
  // the tour is covered by the apiLayering unit test).
  writeFileSync(join(home, "state.json"), JSON.stringify({ onboarded: true }));

  const doc = join(dir, "design.plan.md");
  writeFileSync(doc, "# Plugin E2E\n\nbody text here\n\n<!--inplan v1\n[]\n-->\n");

  app = await electron.launch({
    // No INPLAN_CLI ⇒ no token ⇒ the loader takes the offline-cache branch (verify + load the
    // seeded bundle). INPLAN_PLUGIN_PUBLIC_KEY is read at runtime (dev builds bake no key).
    args: [`--user-data-dir=${join(dir, "userdata")}`, join(REPO, "packages/app"), doc],
    executablePath: join(REPO, "node_modules/.bin/electron"),
    env: { ...process.env, INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(dir, "sidecars"), INPLAN_PLUGIN_PUBLIC_KEY: PUB_PEM },
  });
  win = await app.firstWindow();
  await expect(win.locator("body")).toContainText("Plugin E2E", { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
});

test("main verified + the renderer imported and activated the signed plugin bundle", async () => {
  // The marker is set by the stub's activate() — reached only if main verified the lease + both
  // files, ran the main entry (start), served the renderer entry over the scheme, and the renderer
  // imported + activated it with the session.
  await expect.poll(() => win.evaluate(() => (globalThis as { __E2E_PLUGIN?: { active?: boolean } }).__E2E_PLUGIN?.active ?? false), { timeout: 8_000 }).toBe(true);
});

test("the editor advertises the plugin's mode from its extraModes", async () => {
  // The cadence toggle only renders with >1 mode, so an Instant button proves extraModes merged
  // through setHostApi onto the host api the editor reads.
  // exact, so "Turn" doesn't also match the "Finish turn" button.
  await expect(win.getByRole("button", { name: "Turn", exact: true })).toBeVisible();
  await expect(win.getByRole("button", { name: "Instant", exact: true })).toBeVisible();
});
