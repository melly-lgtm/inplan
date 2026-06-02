// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards that the `t` from useT() is a stable callback that still tracks the active
// locale when captured inside useCallback(fn, []) — the stale-closure trap that would
// otherwise freeze App's undo/redo/finish-turn status messages to the launch language.

import { act, cleanup, render, screen } from "@testing-library/react";
import { useCallback, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useT, EN } from "../src/i18n";
import type { I18nState } from "../src/api";

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

/** A minimal host controller with a switchable locale, like the web's. */
function makeHost() {
  const catalogs = { en: EN, xx: { "topbar.save": "XX-SAVE" } };
  let state: I18nState = { locale: "en", catalogs, available: [{ code: "en", label: "English" }, { code: "xx", label: "XX" }], setLocale };
  const subs = new Set<(s: I18nState) => void>();
  function setLocale(locale: string) {
    state = { ...state, locale };
    for (const cb of subs) cb(state);
  }
  (window as unknown as { api: unknown }).api = {
    i18n: {
      get: () => state,
      subscribe: (cb: (s: I18nState) => void) => {
        subs.add(cb);
        return () => void subs.delete(cb);
      },
    },
  };
  return { setLocale };
}

function Probe({ sink }: { sink: { frozen: (() => string) | null } }): JSX.Element {
  const t = useT();
  // Captured ONCE (deps []) — the exact pattern Bugbot flagged in App.tsx.
  const frozen = useCallback(() => t("topbar.save"), []);
  useEffect(() => {
    sink.frozen = frozen;
  }, [frozen]);
  return <span data-testid="live">{t("topbar.save")}</span>;
}

describe("useT", () => {
  it("returns a stable callback that follows locale switches even when captured early", () => {
    const host = makeHost();
    const sink: { frozen: (() => string) | null } = { frozen: null };
    render(<Probe sink={sink} />);

    // Baseline: English in both the live render and the frozen callback.
    expect(screen.getByTestId("live").textContent).toBe("Save");
    expect(sink.frozen!()).toBe("Save");

    act(() => host.setLocale("xx"));

    // The live render re-translates, and so does the early-captured callback.
    expect(screen.getByTestId("live").textContent).toBe("XX-SAVE");
    expect(sink.frozen!()).toBe("XX-SAVE");
  });
});
