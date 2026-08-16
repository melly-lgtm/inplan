// SPDX-License-Identifier: AGPL-3.0-or-later
//
// acceptanceFrom (#94): whether an agent edit parks for review or writes canonical directly.
// The bug pinned here: the editor's mode picker records the human's acceptance choice into
// `mode_changed`, which the CLI dropped — so a machine-global `acceptance: "auto"` silently
// bypassed a doc the human had set to review. Per-doc intent must win over the machine default.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEventType, MemoryControlChannel, MemoryDocumentStore, type LogEntry } from "@inplan/core/node";
import { acceptanceFrom, waitCycle, type WaitBackend } from "../src/cli";
import { proposedContent } from "./helpers";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-acceptance-"));
  process.env.INPLAN_HOME = home;
  process.env.INPLAN_DEBOUNCE_MS = "25";
  process.env.INPLAN_POLL_MS = "2";
});
afterEach(() => {
  delete process.env.INPLAN_HOME;
  delete process.env.INPLAN_DEBOUNCE_MS;
  delete process.env.INPLAN_POLL_MS;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const globalAuto = () => writeFileSync(join(home, "settings.json"), JSON.stringify({ acceptance: "auto" }));

let seq = 0;
const e = (type: string, payload?: unknown): LogEntry => ({ seq: ++seq, ts: `2026-08-15T00:00:${String(seq).padStart(2, "0")}.000Z`, actor: "user", type, ...(payload !== undefined ? { payload } : {}) });

describe("acceptanceFrom — per-doc intent wins over the machine-global file", () => {
  it("defaults to review with no events and no global file", () => {
    expect(acceptanceFrom([])).toBe("review");
  });

  it("the machine-global file applies only when the doc's history carries no acceptance", () => {
    globalAuto();
    expect(acceptanceFrom([])).toBe("auto");
  });

  it("mode_changed acceptance is honored (the #94 bug: it was dropped)", () => {
    expect(acceptanceFrom([e(LogEventType.ModeChanged, { cadence: "turn", acceptance: "auto" })])).toBe("auto");
  });

  it("a doc set to review in the mode picker overrides a machine-global auto (the bypass)", () => {
    globalAuto();
    expect(acceptanceFrom([e(LogEventType.ModeChanged, { cadence: "live", acceptance: "review" })])).toBe("review");
  });

  it("the LATEST acceptance-carrying event wins, regardless of type", () => {
    expect(
      acceptanceFrom([e(LogEventType.SettingsChanged, { acceptance: "auto" }), e(LogEventType.ModeChanged, { cadence: "turn", acceptance: "review" })]),
    ).toBe("review");
    expect(
      acceptanceFrom([e(LogEventType.ModeChanged, { cadence: "turn", acceptance: "review" }), e(LogEventType.SettingsChanged, { acceptance: "auto" })]),
    ).toBe("auto");
  });

  it("events without a usable acceptance are skipped, not treated as a reset", () => {
    const entries = [
      e(LogEventType.SettingsChanged, { acceptance: "review" }),
      e(LogEventType.ModeChanged, { cadence: "live", wake: "any-action" }), // an older mode event shape
      e(LogEventType.SettingsChanged, { autoResolve: true }),
    ];
    expect(acceptanceFrom(entries)).toBe("review");
  });
});

describe("the bypass, end to end through waitCycle", () => {
  const DOC_A = "# Plan\n\nOriginal body.\n\n<!--inplan\n[]\n-->\n";
  const DOC_B = "# Plan\n\nAgent-edited body.\n\n<!--inplan\n[]\n-->\n";

  it("machine-global auto + doc set to review ⇒ the edit PARKS; canonical is untouched", async () => {
    globalAuto(); // the forgotten local preference that used to bypass the review gate
    const channel = new MemoryControlChannel();
    await channel.append({ actor: "user", type: LogEventType.ModeChanged, payload: { cadence: "turn", acceptance: "review", wake: "turn-end", locksEditor: true } });
    const store = new MemoryDocumentStore(DOC_B);
    const backend: WaitBackend = { channel, store, history: async () => (await channel.readSince(0)).entries, logExit: () => {} };
    const gate = { readCanonical: async () => DOC_A, applyRevision: vi.fn(async () => {}) };
    const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const se = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pre = new Map((["SIGTERM", "SIGHUP", "SIGINT"] as const).map((s) => [s, new Set(process.listeners(s))]));
    try {
      const run = waitCycle(backend, null, new Set(), undefined, gate);
      // End the human's turn as soon as the park lands, so the wait wakes and returns. Bounded:
      // on the regression this pins (the edit auto-applies and never parks), the park event never
      // arrives — fail fast with the diagnosis instead of spinning into vitest's global timeout.
      const deadline = Date.now() + 3_000;
      for (;;) {
        const { entries } = await channel.readSince(0);
        if (entries.some((x) => x.type === LogEventType.AgentRevisionProposed)) break;
        if (Date.now() > deadline) {
          await channel.append({ actor: "user", type: LogEventType.TurnEnded }); // unblock the waiter before failing
          await run.catch(() => {});
          throw new Error(`the edit never parked as a proposal — the review gate was bypassed (applyRevision called: ${gate.applyRevision.mock.calls.length > 0})`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      await channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await expect(run).resolves.toBe("ok");

      expect(gate.applyRevision).not.toHaveBeenCalled(); // no direct canonical write — the gate held
      expect(await proposedContent(store)).toBe(DOC_B); // the edit is parked for the human
    } finally {
      so.mockRestore();
      se.mockRestore();
      for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
        for (const l of process.listeners(sig)) if (!pre.get(sig)!.has(l)) process.off(sig, l);
      }
    }
  });
});
