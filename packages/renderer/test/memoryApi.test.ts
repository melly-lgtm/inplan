// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

describe("createMemoryApi", () => {
  it("loads the initial document and seeds canonical", async () => {
    const { api } = createMemoryApi({ content: "# Plan" });
    expect((await api.load()).content).toBe("# Plan");
  });

  it("surfaces a Review proposal and applies it silently on accept", async () => {
    const { api, agent } = createMemoryApi({ content: "# Plan\n\nold" });
    await api.load();
    let surfaced: string | null = null;
    api.onProposal((p) => (surfaced = p.content));

    agent.proposeRevision("# Plan\n\nnew");
    expect(surfaced).toBe("# Plan\n\nnew"); // onProposal fired with the proposed content
    expect(await api.getProposal()).toBe("# Plan\n\nnew"); // durable, re-readable

    // Accepting = a silent "apply" save: writes canonical, does NOT wake the agent.
    await api.save("# Plan\n\nnew", { kind: "apply", cadence: "turn" });
    await api.clearProposal();
    expect(await api.getProposal()).toBeNull();
    const types = (await agent.log()).map((e) => e.type);
    expect(types).toContain(LogEventType.AgentRevisionProposed);
    expect(types).not.toContain(LogEventType.TurnEnded); // apply stayed silent
  });

  it("fires onExternalChange for an auto-accept edit", async () => {
    const { api, agent } = createMemoryApi({ content: "a" });
    let got: string | null = null;
    api.onExternalChange((p) => (got = p.content));
    agent.externalChange("b");
    expect(got).toBe("b");
  });

  it("Finish turn (canonical save) wakes the agent; backup does not", async () => {
    const { api, agent } = createMemoryApi({ content: "x" });
    await api.save("x2", { kind: "backup", cadence: "turn" });
    expect((await agent.log()).some((e) => e.type === LogEventType.TurnEnded)).toBe(false);
    await api.save("x3", { kind: "canonical", cadence: "turn" });
    expect((await agent.log()).some((e) => e.type === LogEventType.TurnEnded)).toBe(true);
  });

  it("routes done / active / reload signals to their callbacks", async () => {
    const { api, agent } = createMemoryApi({ content: "x" });
    const hit = { done: false, active: false, reload: false };
    api.onAgentDone(() => (hit.done = true));
    api.onAgentActive(() => (hit.active = true));
    api.onReload(() => (hit.reload = true));
    agent.suggestDone();
    agent.markActive();
    agent.suggestReload();
    expect(hit).toEqual({ done: true, active: true, reload: true });
  });

  it("exit.quit always saves the latest content, logs session_closed (completed in build mode), and closes", async () => {
    const session = createMemoryApi({ content: "x" });
    session.api.exit!.quit("final", { startBuild: true });
    await Promise.resolve(); // let the fire-and-forget store/log writes settle
    expect(session.isClosed()).toBe(true);
    expect((await session.api.load()).content).toBe("final"); // saved unconditionally on quit
    const closed = (await session.agent.log()).find((e) => e.type === LogEventType.SessionClosed);
    expect((closed?.payload as { reason?: string } | undefined)?.reason).toBe("completed");
  });

  it("exit.quit without build mode logs window_closed (and still saves)", async () => {
    const session = createMemoryApi({ content: "x" });
    session.api.exit!.quit("kept", { startBuild: false });
    await Promise.resolve();
    expect((await session.api.load()).content).toBe("kept");
    const closed = (await session.agent.log()).find((e) => e.type === LogEventType.SessionClosed);
    expect((closed?.payload as { reason?: string } | undefined)?.reason).toBe("window_closed");
  });
});
