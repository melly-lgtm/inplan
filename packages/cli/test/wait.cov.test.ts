// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, type ControlChannel, type LogEntry } from "@inplan/core/node";
import { describe, expect, it } from "vitest";
import { waitForActions } from "../src/wait";

// A channel whose isSuperseded() and presence() throw, to exercise wait's
// "keep waiting on a read blip" catch branches; readSince yields one actionable
// user entry so the wait still resolves.
function flakyChannel(): ControlChannel {
  const entry: LogEntry = { seq: 1, ts: "t", actor: "user", type: LogEventType.TurnEnded };
  return {
    append: async () => entry,
    readSince: async () => ({ entries: [entry], cursor: 1 }),
    subscribe: () => () => {},
    getCursor: async () => 0,
    setCursor: async () => {},
    claimLock: async () => {},
    isSuperseded: async () => {
      throw new Error("lock unreadable");
    },
    presence: async () => {
      throw new Error("presence unknown");
    },
  };
}

describe("waitForActions resilience", () => {
  it("keeps waiting through isSuperseded/presence errors and still resolves on an action", async () => {
    const r = await waitForActions({ channel: flakyChannel(), cursor: 0, debounceMs: 20, pollMs: 5, watchEditor: true, token: "w" });
    expect(r.entries.map((e) => e.type)).toContain(LogEventType.TurnEnded);
    expect(r.superseded).toBeUndefined();
    expect(r.editorGone).toBeUndefined();
  });
});
