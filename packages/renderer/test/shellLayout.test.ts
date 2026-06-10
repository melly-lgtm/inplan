// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layout invariant: the app shell (.ap-app) must clamp itself to the viewport and hide its
// own overflow, so only the inner panes scroll. Regression guard for the bug where an
// embedder (the web host) mounts the renderer in a parent with no definite height — then a
// plain `height:100%` collapses to auto, the shell grows to full content height, and the
// whole page scrolls, dragging the top bar + banners off-screen.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

/** The declaration block of a single CSS selector rule, or "" if absent. */
function ruleBody(selector: string): string {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`, "m");
  return re.exec(css)?.[1] ?? "";
}

describe("app shell layout invariant", () => {
  const app = ruleBody(".ap-app");

  it("clamps the shell to a viewport-relative height (not parent-dependent height:100%)", () => {
    expect(app).not.toBe("");
    expect(app).toMatch(/height:\s*100dvh/); // self-clamping regardless of the mount parent
    expect(app).toMatch(/height:\s*100vh/); // fallback for engines without dvh
  });

  it("hides shell-level overflow so only the inner panes scroll", () => {
    expect(app).toMatch(/overflow:\s*hidden/);
  });

  it("keeps the inner panes individually scrollable", () => {
    // The bug fix would be pointless if the content panes couldn't scroll on their own.
    expect(ruleBody(".ap-preview")).toMatch(/overflow:\s*auto/);
    expect(ruleBody(".ap-rail-scroll")).toMatch(/overflow:\s*auto/);
    expect(ruleBody(".ap-source")).toMatch(/overflow:\s*auto/);
  });
});
