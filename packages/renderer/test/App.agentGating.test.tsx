// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In a presence-aware host (web/cloud), Instant mode + Finish-turn are disabled
// when no agent is attached (nothing to hand the turn to). The desktop's local
// agent is implicit (not presence-aware), so those controls stay enabled there.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import type { ProfileController, ProfileState } from "../src/api";
import { INSTANT_TEST_MODE } from "./testModes";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
const profileOf = (state: ProfileState): ProfileController => ({ get: () => state, subscribe: () => () => {} });

/** A ProfileController whose snapshot can change mid-test, so a presence drop is observable the way
 *  the real host delivers it (useSyncExternalStore needs a NEW object identity per change). */
function mutableProfile(initial: ProfileState) {
  let state = initial;
  const subs = new Set<(s: ProfileState) => void>();
  return {
    controller: {
      get: () => state,
      subscribe: (cb: (s: ProfileState) => void) => {
        subs.add(cb);
        return () => void subs.delete(cb);
      },
    } as ProfileController,
    set(patch: Partial<ProfileState>) {
      state = { ...state, ...patch };
      subs.forEach((cb) => cb(state));
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(cleanup);

async function renderApp(profile?: ProfileState, controller?: ProfileController) {
  const session = createMemoryApi({ content: DOC });
  session.api.extraModes = [INSTANT_TEST_MODE]; // instant is host-injected (open-core ships turn-only)
  const api = session.api as unknown as { profile?: ProfileController };
  if (controller) api.profile = controller;
  else if (profile) api.profile = profileOf(profile);
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

  // Handing the turn over is what drops a turn-based local agent's presence peer: its CLI exits so
  // the agent can think, and only re-attaches on the next `wait`. Gating purely on presence then
  // disables the agent-dependent controls for exactly as long as the agent is busy — treating "busy"
  // as "gone". (Finish-turn is separately, and correctly, disabled by the turn lock here; the cadence
  // toggle is not, which makes it the honest witness for the presence-only bug.)
  it("keeps agent-dependent controls enabled while the agent works with no presence peer", async () => {
    const live = mutableProfile({ user: { name: "Diane" }, agentLocation: "local", presenceAware: true, actions: [] });
    await renderApp(undefined, live.controller);
    expect(instantBtn().disabled).toBe(false);

    fireEvent.click(finishBtn()); // hand the turn over — the agent now holds it
    await waitFor(() => expect(document.body.textContent).toMatch(/Agent is thinking/i));

    live.set({ agentLocation: null }); // its CLI exited to do the work; the presence peer is gone
    await waitFor(() => expect(screen.getByRole("button", { name: /agent connection/i }).textContent).toMatch(/working/i));
    expect(instantBtn().disabled).toBe(false); // still attached — it is thinking, not absent
  });

  it("still disables them when the agent is absent and no turn is outstanding", async () => {
    const live = mutableProfile({ user: { name: "Diane" }, agentLocation: "local", presenceAware: true, actions: [] });
    await renderApp(undefined, live.controller);
    live.set({ agentLocation: null }); // dropped without ever being handed a turn
    await waitFor(() => expect(instantBtn().disabled).toBe(true));
    expect(screen.getByRole("button", { name: /agent connection/i }).textContent).toMatch(/disconnected/i);
  });

  it("leaves them enabled on a non-presence-aware host (desktop, implicit local agent)", async () => {
    await renderApp(); // no profile wired (desktop / tests)
    expect(instantBtn().disabled).toBe(false);
    expect(finishBtn().disabled).toBe(false);
  });
});
