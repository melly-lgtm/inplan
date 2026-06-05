// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Session.dispatchLog — the desktop editor's event-driven pump (M4.11). Proves the
// editor reacts to control-log events, not a raw working-file watch: an accepted
// agent edit loads the working file; a parked Review proposal loads proposed.md and
// is NOT adopted as an external change (so the diff baseline never moves — the fix
// for the empty-diff race).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEventType, type LogEntry } from "@inplan/core/node";
import { Session } from "../src/main/session";

let dir: string;
let session: Session;
function handlers() {
  return { onExternalChange: vi.fn(), onAgentDone: vi.fn(), onAgentActive: vi.fn(), onProposal: vi.fn(), onReload: vi.fn(), onAgentMessage: vi.fn() };
}
let seq = 0;
const entry = (actor: "user" | "agent", type: string, payload?: unknown): LogEntry => ({ seq: ++seq, ts: "2026-06-01T00:00:00Z", actor, type, ...(payload !== undefined ? { payload } : {}) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-app-"));
  process.env.INPLAN_SIDECAR_DIR = dir;
  seq = 0;
  const file = join(dir, "PLAN.md");
  writeFileSync(file, "# Plan\n\nACCEPTED body.\n");
  session = new Session(file);
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  vi.restoreAllMocks();
});

describe("Session.dispatchLog", () => {
  it("an accepted agent edit loads the working file + clears 'thinking'", () => {
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20 }), entry("agent", LogEventType.AgentRevised)], h);
    expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n");
    expect(h.onAgentActive).toHaveBeenCalled();
    expect(h.onProposal).not.toHaveBeenCalled();
  });

  it("relays each agent message (text + ts) to onAgentMessage, in order", () => {
    const h = handlers();
    session.dispatchLog(
      [entry("agent", LogEventType.AgentMessage, { text: "first" }), entry("agent", LogEventType.AgentMessage, { text: "second" })],
      h,
    );
    expect(h.onAgentMessage).toHaveBeenNthCalledWith(1, "first", "2026-06-01T00:00:00Z");
    expect(h.onAgentMessage).toHaveBeenNthCalledWith(2, "second", "2026-06-01T00:00:00Z");
  });

  it("a parked Review proposal loads proposed.md and is NOT adopted as an external change", () => {
    writeFileSync(session.paths.proposedPath, "# Plan\n\nPROPOSED rewrite.\n");
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.AgentRevisionProposed, { bytes: 22 }), entry("agent", LogEventType.AgentRevised)], h);
    expect(h.onProposal).toHaveBeenCalledWith("# Plan\n\nPROPOSED rewrite.\n");
    expect(h.onExternalChange).not.toHaveBeenCalled(); // baseline never moves → no empty-diff race
    expect(h.onAgentActive).toHaveBeenCalled();
  });

  it("ignores a proposal event with no parked file", () => {
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.AgentRevisionProposed)], h);
    expect(h.onProposal).not.toHaveBeenCalled();
  });

  it("routes done / reload signals", () => {
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.AgentDoneSuggested), entry("agent", LogEventType.ReloadSuggested)], h);
    expect(h.onAgentDone).toHaveBeenCalled();
    expect(h.onReload).toHaveBeenCalled();
  });

  it("a bare re-engagement clears 'thinking' without loading the file", () => {
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.AgentRevised)], h);
    expect(h.onAgentActive).toHaveBeenCalled();
    expect(h.onExternalChange).not.toHaveBeenCalled();
  });

  it("never adopts the human's own (user) edits as external changes", () => {
    const h = handlers();
    session.dispatchLog([entry("user", LogEventType.DocumentEdited), entry("user", LogEventType.TurnEnded)], h);
    expect(h.onExternalChange).not.toHaveBeenCalled();
    expect(h.onAgentActive).not.toHaveBeenCalled();
  });

  it("no-ops on an empty batch", () => {
    const h = handlers();
    session.dispatchLog([], h);
    expect(h.onExternalChange).not.toHaveBeenCalled();
  });
});
