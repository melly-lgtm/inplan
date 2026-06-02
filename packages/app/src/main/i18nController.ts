// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop i18n: localized editor UI is the PAID perk, so the non-English catalogs are
// NOT bundled in this open-core app — they're fetched from the cloud, entitlement-gated.
// The `inplan` CLI (the cloud client) mints a token; on launch we fetch a manifest (the
// offered locales + whether this user is entitled) and each chosen locale's catalog on
// demand, caching to ~/.inplan so the picker survives restarts. Anything we can't verify
// online (logged out / offline / free) falls back to the renderer's built-in English.
// The renderer reads all this through `window.api.i18n`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Snapshot handed to the renderer (no functions cross IPC; the preload adds setLocale). */
export interface I18nSnapshot {
  locale: string;
  catalogs: Record<string, Record<string, string>>;
  available: { code: string; label: string }[];
}

/** English is always available + built into the renderer; we never ship its catalog. */
const EN = { code: "en", label: "English" };
const ENGLISH_ONLY: I18nSnapshot = { locale: "en", catalogs: {}, available: [EN] };

export interface I18nDeps {
  /** Run an `inplan` subcommand, returning stdout (reused: the app already shells the CLI). */
  runCli: (args: string[]) => Promise<{ stdout: string }>;
  /** Cloud base URL, e.g. https://inplan.ai (same origin as the collab endpoints). */
  cloudBase: string;
  /** Notify the renderer the snapshot changed (wired to a `webContents.send`). */
  onChange: () => void;
  /** Override the cache dir (tests). Defaults to INPLAN_HOME or ~/.inplan (matches the CLI). */
  home?: string;
}

export interface I18nController {
  getSnapshot(): I18nSnapshot;
  /** Fetch the manifest (+ the active locale's catalog) and refresh the snapshot. */
  bootstrap(): Promise<void>;
  /** Switch locale, lazily fetching that catalog the first time (entitlement re-checked). */
  setLocale(code: string): Promise<void>;
}

export function createI18nController(deps: I18nDeps): I18nController {
  const base = deps.home || process.env.INPLAN_HOME || join(homedir(), ".inplan");
  const cachePath = join(base, "i18n-cache.json");
  let snap: I18nSnapshot = { ...ENGLISH_ONLY };
  // Monotonic generation: bootstrap + setLocale are async and fired concurrently (launch,
  // sign-in, sign-out, user switches). Each captures the current gen and bails after every
  // await if a newer operation has started — so a stale run can't clobber a newer result
  // (e.g. an old launch bootstrap writing cached paid data after a sign-out reset).
  let gen = 0;

  function persist(): void {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(snap));
    } catch {
      /* best-effort cache */
    }
  }
  function loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<I18nSnapshot>;
      if (raw && typeof raw.locale === "string" && raw.catalogs && Array.isArray(raw.available)) {
        snap = { locale: raw.locale, catalogs: raw.catalogs as I18nSnapshot["catalogs"], available: raw.available as I18nSnapshot["available"] };
      }
    } catch {
      /* no/invalid cache → built-in English */
    }
  }

  /** A fresh access token from the signed-in CLI session, or null (logged out / offline). */
  async function token(): Promise<string | null> {
    try {
      const { stdout } = await deps.runCli(["token"]);
      return (JSON.parse(stdout.trim() || "{}") as { token?: string }).token ?? null;
    } catch {
      return null;
    }
  }

  async function getJson(path: string, tok: string): Promise<unknown | null> {
    try {
      const res = await fetch(`${deps.cloudBase}${path}`, { headers: { authorization: `Bearer ${tok}` } });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** Fetch one locale's catalog (or null). Pure — the caller merges it after re-checking
   *  the generation guard, so a stale fetch never mutates a newer snapshot. */
  async function fetchCatalog(code: string, tok: string): Promise<Record<string, string> | null> {
    const j = (await getJson(`/api/v1/i18n/catalog?locale=${encodeURIComponent(code)}`, tok)) as { catalog?: Record<string, string> } | null;
    return j?.catalog ?? null;
  }

  /** Present English now without touching the cache — for an *indeterminate* state (no
   *  token: logged out OR offline). We don't wipe the cache, so a signed-in user whose
   *  token refresh merely failed keeps their cached catalogs for the next online launch. */
  function presentEnglish(): void {
    snap = { ...ENGLISH_ONLY };
    deps.onChange();
  }

  /** Reset to English AND persist it — for a *definitive* "not paid" (the manifest says
   *  free/lapsed), so the perk is dropped durably. */
  function toEnglish(): void {
    snap = { ...ENGLISH_ONLY };
    persist();
    deps.onChange();
  }

  async function bootstrap(): Promise<void> {
    const myGen = ++gen;
    // Load the cache into memory (catalogs to reuse + the persisted locale) but DON'T push
    // it to the renderer yet: presenting the cached paid locale before the session is
    // verified would briefly show localized UI to a logged-out user. We only reveal the
    // cached state once a token proves a session (below).
    loadCache();
    const cachedSnap = snap;
    snap = { ...ENGLISH_ONLY }; // what the renderer sees until verification
    const tok = await token();
    if (myGen !== gen) return; // superseded (e.g. a sign-out fired meanwhile) → abandon
    if (!tok) return presentEnglish(); // no session (logged out / offline) → English, keep the cache
    // A token proves a signed-in session, so it's safe to reveal the cached locale now.
    snap = cachedSnap;
    const manifest = (await getJson("/api/v1/i18n", tok)) as { entitled?: boolean; locales?: { code: string; label: string }[] } | null;
    if (myGen !== gen) return;
    if (!manifest) return deps.onChange(); // signed in but the check is unreachable (offline) → show the cached language
    if (!manifest.entitled) return toEnglish(); // definitively free / lapsed → English only, no picker (wipe)
    snap.available = [EN, ...(manifest.locales ?? [])];
    // A persisted locale that's no longer offered (or English) needs no catalog.
    if (snap.locale !== "en" && !snap.available.some((l) => l.code === snap.locale)) snap.locale = "en";
    // Ensure the active locale's catalog is present; if it can't be fetched, fall back to
    // English (consistent with setLocale) so we never show a non-English locale with no strings.
    if (snap.locale !== "en" && !snap.catalogs[snap.locale]) {
      const cat = await fetchCatalog(snap.locale, tok);
      if (myGen !== gen) return;
      if (cat) snap.catalogs = { ...snap.catalogs, [snap.locale]: cat };
      else snap.locale = "en";
    }
    persist();
    deps.onChange();
  }

  async function setLocale(code: string): Promise<void> {
    const myGen = ++gen;
    if (code === snap.locale) return;
    if (code !== "en" && !snap.available.some((l) => l.code === code)) return; // not offered
    if (code !== "en" && !snap.catalogs[code]) {
      const tok = await token();
      if (myGen !== gen || !tok) return;
      const cat = await fetchCatalog(code, tok);
      if (myGen !== gen || !cat) return; // superseded, or couldn't fetch → don't switch
      snap.catalogs = { ...snap.catalogs, [code]: cat };
    }
    snap.locale = code;
    persist();
    deps.onChange();
  }

  return { getSnapshot: () => snap, bootstrap, setLocale };
}
