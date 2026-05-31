// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../src/renderer/memoryApi";

describe("createMemoryApi — settings, mode, misc", () => {
  it("setMode logs a mode_changed event", async () => {
    const { api, agent } = createMemoryApi({ content: "x" });
    await api.setMode("instant", "review");
    expect((await agent.log()).find((e) => e.type === LogEventType.ModeChanged)?.payload).toEqual({ cadence: "instant", acceptance: "review" });
  });

  it("getSettings reflects setSettings, which also logs settings_changed", async () => {
    const { api, agent } = createMemoryApi({ content: "x", settings: { autoResolve: true } });
    expect(await api.getSettings()).toEqual({ autoResolve: true });
    await api.setSettings({ autoResolve: false });
    expect(await api.getSettings()).toEqual({ autoResolve: false });
    expect((await agent.log()).some((e) => e.type === LogEventType.SettingsChanged)).toBe(true);
  });

  it("logAction appends a user event; reportState is a no-op; closeWindow marks closed", async () => {
    const session = createMemoryApi({ content: "x" });
    await session.api.logAction(LogEventType.CommentResolved, { id: "cmt-1" });
    expect((await session.agent.log()).some((e) => e.type === LogEventType.CommentResolved)).toBe(true);
    await session.api.reportState(false, "x"); // no throw, no event
    expect(session.isClosed()).toBe(false);
    await session.api.closeWindow();
    expect(session.isClosed()).toBe(true);
  });
});
