// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, type LogEntry } from "@inplan/core/node";
import { describe, expect, it } from "vitest";
import { wakePredicate } from "../src/wait";

function entry(partial: Partial<LogEntry>): LogEntry {
  return { seq: 1, ts: "t", actor: "user", type: "x", ...partial };
}

describe("wakePredicate", () => {
  it("Turn mode wakes only on turn_ended / session_closed, not on comment actions", () => {
    const turn = wakePredicate("turn");
    expect(turn(entry({ actor: "user", type: LogEventType.CommentAnswered }))).toBe(false);
    expect(turn(entry({ actor: "user", type: LogEventType.CommentCreated }))).toBe(false);
    expect(turn(entry({ type: LogEventType.TurnEnded }))).toBe(true);
    expect(turn(entry({ type: LogEventType.SessionClosed }))).toBe(true);
  });

  it("Instant mode wakes on any user action but not on agent entries", () => {
    const instant = wakePredicate("instant");
    expect(instant(entry({ actor: "user", type: LogEventType.CommentAnswered }))).toBe(true);
    expect(instant(entry({ actor: "user", type: LogEventType.CommentCreated }))).toBe(true);
    expect(instant(entry({ actor: "agent", type: LogEventType.DocumentEdited }))).toBe(false);
  });
});
