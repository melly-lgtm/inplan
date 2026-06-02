// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { translate, EN } from "../src/i18n";
import type { I18nState } from "../src/api";

const state = (over: Partial<I18nState> = {}): I18nState => ({
  locale: "en",
  catalogs: { en: EN },
  available: [{ code: "en", label: "English" }],
  setLocale: () => {},
  ...over,
});

describe("translate", () => {
  it("returns the active-locale string when present", () => {
    const s = state({ locale: "fr", catalogs: { en: EN, fr: { "profile.language": "Langue" } } });
    expect(translate(s, "profile.language")).toBe("Langue");
  });

  it("falls back to English, then to the key itself", () => {
    expect(translate(state(), "topbar.save")).toBe("Save"); // from EN base
    expect(translate(state(), "totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("a missing key in the active locale falls back to English", () => {
    const s = state({ locale: "fr", catalogs: { en: EN, fr: {} } });
    expect(translate(s, "topbar.turn")).toBe("Turn");
  });

  it("interpolates {vars}", () => {
    const s = state({ catalogs: { en: { ...EN, greet: "Hi {name}, {n} panes" } } });
    expect(translate(s, "greet", { name: "Dana", n: 3 })).toBe("Hi Dana, 3 panes");
    expect(translate(s, "greet", { name: "Dana" })).toBe("Hi Dana, {n} panes"); // missing var kept visible
  });
});
