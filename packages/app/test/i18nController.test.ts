// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18nController, type I18nDeps } from "../src/main/i18nController";

const FR = { "topbar.save": "Enregistrer", "topbar.turn": "Tour" };
const JA = { "topbar.save": "保存" };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-i18n-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A controller with a mocked CLI token + a routed fetch (manifest + per-locale catalog). */
function setup(opts: { token?: string | null; entitled?: boolean; locales?: { code: string; label: string }[]; manifestNull?: boolean }) {
  const runCli = vi.fn(async (args: string[]) => ({ stdout: args[0] === "token" ? JSON.stringify(opts.token === undefined ? { token: "T" } : opts.token ? { token: opts.token } : {}) : "{}" }));
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/api/v1/i18n")) {
      if (opts.manifestNull) return { ok: false } as Response;
      return { ok: true, json: async () => ({ entitled: opts.entitled ?? false, locales: opts.locales ?? [{ code: "fr", label: "Français" }, { code: "ja", label: "日本語" }] }) } as Response;
    }
    if (url.includes("/api/v1/i18n/catalog")) {
      const code = new URL(url).searchParams.get("locale");
      const catalog = code === "fr" ? FR : code === "ja" ? JA : null;
      return catalog ? ({ ok: true, json: async () => ({ locale: code, catalog }) } as Response) : ({ ok: false } as Response);
    }
    return { ok: false } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  const deps: I18nDeps = { runCli, cloudBase: "https://inplan.ai", onChange, home };
  return { ctrl: createI18nController(deps), runCli, fetchMock, onChange };
}

describe("i18nController.bootstrap", () => {
  it("logged out → English only, no picker", async () => {
    const { ctrl, fetchMock } = setup({ token: null });
    await ctrl.bootstrap();
    expect(ctrl.getSnapshot()).toEqual({ locale: "en", catalogs: {}, available: [{ code: "en", label: "English" }] });
    expect(fetchMock).not.toHaveBeenCalled(); // no token ⇒ never hits the cloud
  });

  it("no token presents English but does NOT wipe the cache (offline signed-in user keeps catalogs)", async () => {
    const cached = { locale: "fr", catalogs: { fr: FR }, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] };
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify(cached));
    const { ctrl } = setup({ token: null });
    await ctrl.bootstrap();
    expect(ctrl.getSnapshot().locale).toBe("en"); // presented English (the perk needs a verified session)
    expect(JSON.parse(readFileSync(join(home, "i18n-cache.json"), "utf8"))).toEqual(cached); // cache preserved
  });

  it("never pushes a non-English snapshot before the session is verified (no pre-auth leak)", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "fr", catalogs: { fr: FR }, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as Response));
    const seen: string[] = [];
    let ctrl!: ReturnType<typeof createI18nController>;
    ctrl = createI18nController({ runCli: async () => ({ stdout: "{}" }), cloudBase: "https://inplan.ai", home, onChange: () => seen.push(ctrl.getSnapshot().locale) });
    await ctrl.bootstrap(); // logged out, but the cache holds a paid French snapshot
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l === "en")).toBe(true); // the renderer only ever saw English
  });

  it("definitively free wipes the cache to English", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "fr", catalogs: { fr: FR }, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }));
    const { ctrl } = setup({ token: "T", entitled: false });
    await ctrl.bootstrap();
    expect(ctrl.getSnapshot().available).toEqual([{ code: "en", label: "English" }]);
    expect(JSON.parse(readFileSync(join(home, "i18n-cache.json"), "utf8")).locale).toBe("en"); // wiped
  });

  it("entitled → exposes English + the offered locales (catalogs lazy)", async () => {
    const { ctrl } = setup({ token: "T", entitled: true });
    await ctrl.bootstrap();
    const s = ctrl.getSnapshot();
    expect(s.available.map((l) => l.code)).toEqual(["en", "fr", "ja"]);
    expect(s.locale).toBe("en");
    expect(s.catalogs).toEqual({}); // nothing fetched until a non-English locale is chosen
  });

  it("free / lapsed → English only even if entitled-shaped locales exist", async () => {
    const { ctrl } = setup({ token: "T", entitled: false });
    await ctrl.bootstrap();
    expect(ctrl.getSnapshot().available).toEqual([{ code: "en", label: "English" }]);
  });

  it("offline (manifest unreachable) → keeps whatever the cache showed", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "fr", catalogs: { fr: FR }, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }));
    const { ctrl } = setup({ token: "T", manifestNull: true });
    await ctrl.bootstrap();
    expect(ctrl.getSnapshot().locale).toBe("fr"); // cache preserved when the online check fails
  });

  it("entitled but the persisted locale's catalog can't be fetched → falls back to English", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "xx", catalogs: {}, available: [{ code: "en", label: "English" }, { code: "xx", label: "X" }] }));
    const { ctrl } = setup({ token: "T", entitled: true, locales: [{ code: "en", label: "English" }, { code: "xx", label: "X" }] });
    await ctrl.bootstrap(); // manifest offers "xx" but /catalog?locale=xx returns !ok
    expect(ctrl.getSnapshot().locale).toBe("en");
  });

  it("entitled with a persisted non-English locale → fetches that catalog on launch", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "fr", catalogs: {}, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }));
    const { ctrl } = setup({ token: "T", entitled: true });
    await ctrl.bootstrap();
    const s = ctrl.getSnapshot();
    expect(s.locale).toBe("fr");
    expect(s.catalogs.fr).toEqual(FR);
  });
});

describe("i18nController concurrency", () => {
  it("a stale bootstrap cannot overwrite a newer logout (generation guard)", async () => {
    writeFileSync(join(home, "i18n-cache.json"), JSON.stringify({ locale: "fr", catalogs: { fr: FR }, available: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }));
    let releaseToken!: () => void;
    const gate = new Promise<void>((r) => (releaseToken = r));
    let call = 0;
    const runCli = vi.fn(async (args: string[]) => {
      if (args[0] !== "token") return { stdout: "{}" };
      call += 1;
      if (call === 1) {
        await gate; // first (entitled) run is slow…
        return { stdout: JSON.stringify({ token: "T" }) };
      }
      return { stdout: "{}" }; // …the second run is a sign-out (no token)
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entitled: true, locales: [{ code: "fr", label: "Français" }] }) }) as Response));
    const seen: string[] = [];
    let ctrl!: ReturnType<typeof createI18nController>;
    ctrl = createI18nController({ runCli, cloudBase: "https://inplan.ai", home, onChange: () => seen.push(ctrl.getSnapshot().locale) });

    const stale = ctrl.bootstrap(); // gen 1 — blocks on the token gate
    await ctrl.bootstrap(); // gen 2 — logged out → presentEnglish
    releaseToken(); // let the stale gen-1 run resume; its generation is now superseded
    await stale;

    expect(ctrl.getSnapshot().locale).toBe("en");
    expect(seen.every((l) => l === "en")).toBe(true); // the stale run never pushed French
  });
});

describe("i18nController.setLocale", () => {
  it("lazily fetches + caches the chosen locale, persists, and notifies", async () => {
    const { ctrl, onChange } = setup({ token: "T", entitled: true });
    await ctrl.bootstrap();
    onChange.mockClear();
    await ctrl.setLocale("ja");
    const s = ctrl.getSnapshot();
    expect(s.locale).toBe("ja");
    expect(s.catalogs.ja).toEqual(JA);
    expect(onChange).toHaveBeenCalled();
    // Persisted: a fresh controller on the same home loads ja from cache.
    const cached = JSON.parse(readFileSync(join(home, "i18n-cache.json"), "utf8"));
    expect(cached.locale).toBe("ja");
  });

  it("ignores a locale that isn't offered", async () => {
    const { ctrl } = setup({ token: "T", entitled: true });
    await ctrl.bootstrap();
    await ctrl.setLocale("de");
    expect(ctrl.getSnapshot().locale).toBe("en");
  });

  it("does not switch when the catalog fetch fails", async () => {
    const { ctrl } = setup({ token: "T", entitled: true, locales: [{ code: "en", label: "English" }, { code: "xx", label: "X" }] });
    await ctrl.bootstrap();
    await ctrl.setLocale("xx"); // offered by manifest, but /catalog returns !ok
    expect(ctrl.getSnapshot().locale).toBe("en");
  });

  it("switching back to English needs no fetch", async () => {
    const { ctrl } = setup({ token: "T", entitled: true });
    await ctrl.bootstrap();
    await ctrl.setLocale("fr");
    await ctrl.setLocale("en");
    expect(ctrl.getSnapshot().locale).toBe("en");
  });
});
