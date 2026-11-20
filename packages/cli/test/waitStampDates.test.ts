// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The repair must LAND. Stamping only the in-memory copy left the working file with its
// fabricated dates forever, so every later wait re-repaired against a fresh now — a phantom
// agent edit per turn, a repeating stderr line, and an ever-drifting canonical. On the file
// model the stamped text is persisted quietly (no document_edited: the agent edited nothing).

import { LogEventType, MemoryControlChannel, MemoryDocumentStore, type LogEntry } from "@inplan/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitCycle, type WaitBackend } from "../src/cli";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const FUTURE = `# Plan\n\nBody.\n\n<!--inplan v1\n[{"id":"cmt-fut1","author":"Agent <a@b>","date":"2099-01-01T00:00:00Z","resolved":false,"anchor":"doc","text":"A fabricated future date."}]\n-->\n`;
/** The same document after one repair: a sane, past date. */
const SANE = FUTURE.replace("2099-01-01T00:00:00Z", "2026-10-27T00:00:00Z");

let err = "";
let restore: () => void;

beforeEach(() => {
  err = "";
  const pre = new Map(SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]));
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((err += String(c)), true));
  const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  restore = () => {
    se.mockRestore();
    so.mockRestore();
    for (const sig of SIGNALS) for (const l of process.listeners(sig)) if (!pre.get(sig)!.has(l)) process.off(sig, l);
  };
});
afterEach(() => restore());

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One waitCycle over `initial`, driven to completion by a turn-end once `ready` fires. */
async function runOnce(initial: string, ready: () => boolean): Promise<{ file: string; canonical: string | null; edits: number }> {
  const channel = new MemoryControlChannel();
  const store = new MemoryDocumentStore(initial);
  const backend: WaitBackend = { channel, store, history: async () => (await channel.readSince(0)).entries as LogEntry[], logExit: () => {} };
  const run = waitCycle(backend, null, new Set());
  await waitUntil(ready);
  await channel.append({ actor: "user", type: LogEventType.TurnEnded });
  await expect(run).resolves.toBe("ok");
  return {
    file: await store.loadDoc(),
    canonical: await store.getCanonical(),
    edits: (await channel.readSince(0)).entries.filter((e) => e.type === LogEventType.DocumentEdited).length,
  };
}

describe("the date repair lands (waitCycle wiring)", () => {
  it("persists the stamped file and canonical quietly — no phantom agent edit", async () => {
    const r = await runOnce(FUTURE, () => err.includes("comment date")); // stamping ran

    expect(r.file).not.toContain("2099-01-01"); // the working file itself is repaired…
    expect(r.canonical).toBe(r.file); // …and so is the canonical (only the stamps differed)
    expect(r.edits).toBe(0); // and no agent edit was claimed anywhere
    expect(err.match(/comment date/g)).toHaveLength(1); // reported once, on stderr
  });

  it("a wait over an already-sane file repairs nothing and claims no edit", async () => {
    const r = await runOnce(SANE, () => true);

    expect(err).not.toContain("comment date"); // nothing needed repair…
    expect(r.edits).toBe(0); // …so nothing was logged as an agent edit
    expect(r.file).toContain("2026-10-27"); // the file came through untouched
  });
});
