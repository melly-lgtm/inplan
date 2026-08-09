// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `wait --remote` needs the plugin gate to materialize a working copy: an out-of-process local agent
// can only read and write FILES, and the turn-based store path below the gate was built for the
// managed cloud agent, which holds the body in memory. Without a gate the CLI used to fall through
// and attach anyway — consuming the human's turns while provably unable to read or edit the doc.
//
// These pin the explanation that replaced that silence, and above all that the two reasons stay
// distinct: telling a paying customer to upgrade because a server hiccuped is the worst outcome.

import { describe, expect, it, vi } from "vitest";
import { EXIT_PLUGIN_UNAVAILABLE, EXIT_UPGRADE_REQUIRED, exitAfterFlush, explainNoGate, shellQuote } from "../src/cli";

function capture(fn: () => void): { err: string; out: string } {
  let err = "";
  let out = "";
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((err += String(c)), true));
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((out += String(c)), true));
  try {
    fn();
    return { err, out };
  } finally {
    se.mockRestore();
    so.mockRestore();
  }
}

describe("explainNoGate", () => {
  it("unentitled → names the plan limit and points at the in-product upgrade", () => {
    const { err, out } = capture(() => explainNoGate("unentitled"));
    expect(err).toContain("doesn't include the local agent");
    expect(err).toContain("agent indicator to upgrade");
    expect(JSON.parse(out)).toEqual({ status: "upgrade_required", reason: "unentitled" });
  });

  it("unavailable → explicitly NOT a plan limit, and tells the human to retry", () => {
    const { err, out } = capture(() => explainNoGate("unavailable"));
    expect(err).toContain("not a plan limit");
    expect(err).toContain("retry");
    expect(err).not.toContain("upgrade");
    expect(JSON.parse(out)).toEqual({ status: "plugin_unavailable", reason: "unavailable" });
  });

  it("offers `demote` as the free escape hatch only when a local file exists to demote to", () => {
    const withFile = capture(() => explainNoGate("unentitled", "/w/plan.plan.md"));
    expect(withFile.err).toContain("inplan demote '/w/plan.plan.md'");
    expect(JSON.parse(withFile.out)).toMatchObject({ localFile: "/w/plan.plan.md" });

    // A bare `--remote <docId>` has no file on disk, so promising `demote` would be a dead end.
    const bare = capture(() => explainNoGate("unentitled"));
    expect(bare.err).not.toContain("demote");
    expect(JSON.parse(bare.out)).not.toHaveProperty("localFile");
  });

  it("the transient path also offers demote when there is a local file", () => {
    const { err } = capture(() => explainNoGate("unavailable", "/w/plan.plan.md"));
    expect(err).toContain("inplan demote '/w/plan.plan.md'");
  });

  it("emits exactly one JSON object on stdout, so the agent's parser stays happy", () => {
    const { out } = capture(() => explainNoGate("unentitled", "/w/plan.plan.md"));
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("the two exit codes are distinct and neither collides with the existing ones", () => {
    // 1 generic, 2 integrity_error, 3 confirm_required, 64 usage.
    expect(EXIT_UPGRADE_REQUIRED).not.toBe(EXIT_PLUGIN_UNAVAILABLE);
    expect([EXIT_UPGRADE_REQUIRED, EXIT_PLUGIN_UNAVAILABLE].every((c) => ![0, 1, 2, 3, 64].includes(c))).toBe(true);
  });
});

// The coded exits exist to hand the agent a machine-readable status. Node's stdout is ASYNC when
// piped — the normal case under a coding agent — so `output(...)` followed by a bare `process.exit`
// delivers the code with no payload. These pin that the exit waits for the drain.
describe("exitAfterFlush", () => {
  it("does not exit until BOTH streams have flushed", () => {
    const exit = vi.fn();
    let outCb: (() => void) | undefined;
    let errCb: (() => void) | undefined;
    const out = { write: vi.fn((_c: string, c?: () => void) => ((outCb = c), true)) };
    const err = { write: vi.fn((_c: string, c?: () => void) => ((errCb = c), true)) };
    exitAfterFlush(7, out as never, exit, err as never);
    expect(exit).not.toHaveBeenCalled(); // stdout still buffered — exiting here truncates the JSON
    outCb!();
    expect(err.write).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled(); // stderr is buffered when piped too — the guidance would be lost
    errCb!();
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("queues its barrier AFTER the payload, so ordering guarantees the flush covers it", () => {
    const writes: string[] = [];
    const out = { write: vi.fn((c: string, cb?: () => void) => (writes.push(c), cb?.(), true)) };
    const err = { write: vi.fn((_c: string, cb?: () => void) => (cb?.(), true)) };
    out.write(JSON.stringify({ status: "upgrade_required" }) + "\n");
    exitAfterFlush(4, out as never, vi.fn(), err as never);
    expect(writes[0]).toContain("upgrade_required");
    expect(writes[1]).toBe(""); // the zero-length drain barrier, written last
  });

  it("still exits when the stream reports an error to the callback", () => {
    const exit = vi.fn();
    const out = { write: vi.fn((_c: string, cb?: (e?: Error) => void) => (cb?.(new Error("EPIPE")), true)) };
    const err = { write: vi.fn((_c: string, cb?: (e?: Error) => void) => (cb?.(new Error("EPIPE")), true)) };
    exitAfterFlush(5, out as never, exit, err as never);
    expect(exit).toHaveBeenCalledWith(5); // a broken pipe must not hang the process
  });
});

// The hint is copy-pasted into a shell. An unquoted path with a space silently targets the wrong
// file, and one carrying `$(…)`/backticks/`;` would EXECUTE on paste — a command we printed.
describe("shellQuote", () => {
  it("quotes a plain path", () => {
    expect(shellQuote("/w/plan.plan.md")).toBe("'/w/plan.plan.md'");
  });

  it("keeps a path with spaces a single argument", () => {
    expect(shellQuote("/My Docs/road map.plan.md")).toBe("'/My Docs/road map.plan.md'");
  });

  it("neutralises command substitution, backticks and separators", () => {
    for (const evil of ["/w/$(rm -rf ~).md", "/w/`id`.md", "/w/a;rm -rf /.md", "/w/a&&b.md", "/w/a|b.md", "/w/a$HOME.md"]) {
      const q = shellQuote(evil);
      expect(q.startsWith("'") && q.endsWith("'")).toBe(true);
      expect(q.slice(1, -1)).not.toContain("'"); // nothing can terminate the quote early
    }
  });

  it("escapes an embedded single quote by closing, escaping, and reopening", () => {
    expect(shellQuote("/w/it's.md")).toBe("'/w/it'" + String.fromCharCode(92) + "''s.md'");
  });
});
