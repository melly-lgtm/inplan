// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In a presence-aware host (web/cloud), Instant mode + Finish-turn are disabled
// when no agent is attached (nothing to hand the turn to). The desktop's local
// agent is implicit (not presence-aware), so those controls stay enabled there.

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import type { ProfileController, ProfileState } from "../src/api";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
const profileOf = (state: ProfileState): ProfileController => ({ get: () => state, subscribe: () => () => {} });

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(cleanup);

async function renderApp(profile?: ProfileState) {
  const session = createMemoryApi({ content: DOC });
  const api = session.api as unknown as { profile?: ProfileController };
  if (profile) api.profile = profileOf(profile);
  (window as unknown as { api: unknown }).api = api;
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

const instantBtn = () => within(screen.getByRole("group", { name: "cadence" })).getByRole("button", { name: /instant/i }) as HTMLButtonElement;
const finishBtn = () => screen.getByRole("button", { name: /finish turn/i }) as HTMLButtonElement;

describe("agent-presence gating of Instant + Finish-turn", () => {
  it("disables Instant + Finish-turn in a presence-aware host with no agent attached", async () => {
    await renderApp({ user: { name: "Diane" }, agentLocation: null, presenceAware: true, actions: [] });
    expect(instantBtn().disabled).toBe(true);
    expect(finishBtn().disabled).toBe(true);
  });

  it("enables them once an agent is attached", async () => {
    await renderApp({ user: { name: "Diane" }, agentLocation: "cloud", presenceAware: true, actions: [] });
    expect(instantBtn().disabled).toBe(false);
    expect(finishBtn().disabled).toBe(false);
  });

  it("leaves them enabled on a non-presence-aware host (desktop, implicit local agent)", async () => {
    await renderApp(); // no profile wired (desktop / tests)
    expect(instantBtn().disabled).toBe(false);
    expect(finishBtn().disabled).toBe(false);
  });
});
