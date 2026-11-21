// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Session.dispatchLog — the desktop editor's event-driven pump (M4.11). Proves the
// editor reacts to control-log events, not a raw working-file watch: an accepted
// agent edit loads the working file; a parked Review proposal loads proposed.md and
// is NOT adopted as an external change (so the diff baseline never moves — the fix
// for the empty-diff race).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLog, FsDocumentStore, hashBody, LogEventType, type LogEntry } from "@inplan/core/node";
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
    // No canonical sidecar yet (nothing has loaded or gated this doc): the working file is the
    // only copy there is.
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20 }), entry("agent", LogEventType.AgentRevised)], h);
    expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n", { viaPlugin: false });
    expect(h.onAgentActive).toHaveBeenCalled();
    expect(h.onProposal).not.toHaveBeenCalled();
  });

  describe("which copy of an agent edit the editor is handed", () => {
    const LANDED = "# Plan\n\nThe text the gate landed.\n";
    const PROJECTED = "# Plan\n\nA plugin's older projection, written over the working file.\n";

    it("a file-backed edit is read from the CANONICAL, which a plugin cannot have overwritten", () => {
      // The gate advances the canonical to exactly the text it accepted. A live plugin overwrites
      // the WORKING file with its own projection on its own schedule, so by the time this runs
      // that file can hold pre-revision text — which the editor would push into its binding, over
      // the revision that just landed. This is the commonest path, not an edge: the first `open`
      // reads the plugin session before the editor publishes one, so its wait is file-backed
      // while the editor is already bound.
      writeFileSync(session.paths.canonicalPath, LANDED);
      writeFileSync(session.paths.file, PROJECTED);
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20, via: "file" })], h);

      expect(h.onExternalChange).toHaveBeenCalledWith(LANDED, { viaPlugin: false });
    });

    it("a file-backed edit with no canonical yet falls back to the working file", () => {
      rmSync(session.paths.canonicalPath, { force: true });
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20, via: "file" })], h);

      expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n", { viaPlugin: false });
    });

    it("an UNSTAMPED edit reads the working file, exactly as it always did", () => {
      // A CLI that predates the stamp, so the carrier is unknown — and it may have been the plugin,
      // whose path never advances the canonical. An older `wait` still attached across an editor
      // upgrade is the ordinary way to get here; reading the canonical for it would push a sidecar
      // seeded at first load into the shared document.
      writeFileSync(session.paths.canonicalPath, "# Plan\n\nA canonical nothing has advanced in a long time.\n");
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20 })], h);

      expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n", { viaPlugin: false });
    });

    it("an edit that went through the plugin sends the working file, flagged — the renderer decides", () => {
      // The edit is in the shared document; the canonical was not advanced. A renderer bound to
      // the plugin reads its binding and ignores this content; one that never bound has only it.
      writeFileSync(session.paths.canonicalPath, "# Plan\n\nA canonical the plugin path never advances.\n");
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 20, via: "plugin" })], h);

      expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n", { viaPlugin: true });
    });

    it("the LAST agent edit in a coalesced batch decides — file-backed after plugin", () => {
      // The channel coalesces a burst of appends, the carrier is chosen per edit, and the cursor
      // has already advanced: describing the batch by its first edit would drop the newest one.
      writeFileSync(session.paths.canonicalPath, LANDED);
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 1, via: "plugin" }), entry("agent", LogEventType.DocumentEdited, { bytes: 2, via: "file" })], h);

      expect(h.onExternalChange).toHaveBeenCalledTimes(1);
      expect(h.onExternalChange).toHaveBeenCalledWith(LANDED, { viaPlugin: false });
    });

    it("…and plugin after file-backed", () => {
      writeFileSync(session.paths.canonicalPath, LANDED);
      const h = handlers();

      session.dispatchLog([entry("agent", LogEventType.DocumentEdited, { bytes: 1, via: "file" }), entry("agent", LogEventType.DocumentEdited, { bytes: 2, via: "plugin" })], h);

      expect(h.onExternalChange).toHaveBeenCalledTimes(1);
      expect(h.onExternalChange).toHaveBeenCalledWith("# Plan\n\nACCEPTED body.\n", { viaPlugin: true });
    });
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

  it("a parked Review proposal loads proposed.md and is NOT adopted as an external change", async () => {
    writeFileSync(session.paths.proposedPath, "# Plan\n\nPROPOSED rewrite.\n");
    const h = handlers();
    session.dispatchLog([entry("agent", LogEventType.AgentRevisionProposed, { bytes: 22 }), entry("agent", LogEventType.AgentRevised)], h);
    await new Promise((r) => setTimeout(r, 0)); // pendingProposal is row-backed and async now
    // The legacy park is ADOPTED as a row and gains a real identity — but carries NO queue
    // fields: its baseHash is the "" sentinel (no real base was recorded), and surfacing an
    // empty baseContent would put the renderer on a false stale-merge path. Review degrades to
    // the documented legacy single-proposal flow.
    // …and the dispatch is stamped with the session's own doc path, so a late event from a
    // navigated-away document can be ignored by the renderer.
    expect(h.onProposal).toHaveBeenCalledWith("# Plan\n\nPROPOSED rewrite.\n", expect.any(String), undefined, undefined, session.paths.file);
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

describe("Session.load with a parked proposal (#95)", () => {
  it("blank canonical + working file holding the parked text → load serves the canonical; the proposal stays reviewable", async () => {
    // The CLI's #95 wipe guard keeps the parked text in the working file instead of materializing
    // a blank canonical over it. The editor must then baseline on the CANONICAL: served as the
    // file, the re-shown proposal would diff against itself — no hunks for what is an
    // all-additions review against the blank canonical.
    const parked = "# Plan\n\nfirst content, straight from the agent.\n";
    const file = join(dir, "FRESH.md");
    writeFileSync(file, parked);
    const s = new Session(file);
    writeFileSync(s.paths.canonicalPath, ""); // `open` seeded an authoritative-empty canonical
    // Park the proposal exactly as the CLI gate does (row-backed, base = the blank canonical).
    await new FsDocumentStore(s.paths).createProposal({ content: parked, baseHash: hashBody(""), baseContent: "" });

    const loaded = await s.load();
    expect(loaded.content).toBe(""); // the baseline is the canonical, not the proposal under review
    expect((await s.pendingProposal())?.content).toBe(parked); // and the review still shows the parked text
    expect(readFileSync(file, "utf8")).toBe(parked); // load never rewrites the working file
  });

  it("load still serves the working file when it differs from the pending proposal", async () => {
    // The substitution is strictly for "the file IS the proposal": a file the human has since
    // edited (or any accepted doc with a stale sidecar) must load as-is.
    const file = join(dir, "EDITED.md");
    writeFileSync(file, "# Plan\n\nthe human's own edit.\n");
    const s = new Session(file);
    writeFileSync(s.paths.canonicalPath, "");
    await new FsDocumentStore(s.paths).createProposal({ content: "# Plan\n\nsomething else entirely.\n", baseHash: hashBody(""), baseContent: "" });
    expect((await s.load()).content).toBe("# Plan\n\nthe human's own edit.\n");
  });

  it("load with no pending proposal serves the working file unchanged", async () => {
    // Seed the canonical first: with it missing, load() short-circuits on the seed branch and
    // this test would never reach the pendingProposal branch it exists to exercise. Seed it with
    // DISTINCT content — identical strings could not tell which of the two load() served.
    writeFileSync(session.paths.canonicalPath, "# Plan\n\nan older accepted base.\n");
    expect((await session.load()).content).toBe("# Plan\n\nACCEPTED body.\n"); // the file, not the canonical
  });

  it("a failed proposal lookup never blocks loading — load falls back to the working file", async () => {
    // The lookup can reject (rows-lock contention past its deadline, an unreadable sidecar).
    // Sidecar availability must not decide whether the document opens.
    writeFileSync(session.paths.canonicalPath, ""); // canonical present, so the lookup branch runs
    vi.spyOn(session, "pendingProposal").mockRejectedValue(new Error("rows lock timeout"));
    expect((await session.load()).content).toBe("# Plan\n\nACCEPTED body.\n");
  });

  it("a rewrite while the lookup is in flight is served, not masked by the canonical", async () => {
    // The proposal must be compared against what the file holds AFTER the await: a CLI process
    // can rewrite the file mid-lookup, and matching the pre-await snapshot would serve the
    // canonical over a fresh edit that is no longer the proposal.
    const parked = "# Plan\n\nthe parked text.\n";
    const fresh = "# Plan\n\na newer CLI write, landed mid-lookup.\n";
    const file = join(dir, "RACE.md");
    writeFileSync(file, parked);
    const s = new Session(file);
    writeFileSync(s.paths.canonicalPath, "");
    vi.spyOn(s, "pendingProposal").mockImplementation(async () => {
      writeFileSync(file, fresh); // the CLI rewrites the file while the lookup is in flight
      return { id: "p-race", content: parked }; // the proposal equals the PRE-await snapshot
    });
    expect((await s.load()).content).toBe(fresh); // the fresh edit is served, not the blank canonical
  });
});

describe("Session.complete clears the unsaved flag", () => {
  it("writes the content and resets hasUnsaved, so quitNow's flush guard can't re-write stale pending", () => {
    session.setPending(true, "# Plan\n\nstale pending.\n");
    expect(session.hasUnsaved).toBe(true);
    session.complete("# Plan\n\nsaved on quit.\n");
    // Persisted, and nothing is unsaved → a later `if (hasUnsaved) complete(pending)` won't fire.
    expect(session.hasUnsaved).toBe(false);
    expect(session.pending).toBe("# Plan\n\nsaved on quit.\n");
    expect(readFileSync(join(dir, "PLAN.md"), "utf8")).toBe("# Plan\n\nsaved on quit.\n");
  });
});

describe("Session.load reports a first draft the agent has yet to write", () => {
  // `inplan open` logs DraftPending when an agent creates the document; the editor shows a
  // dismissible "may be writing the first draft" banner for as long as that is still true.
  const log = (actor: "user" | "agent", type: string, payload?: unknown): void => {
    appendLog(session.paths.logPath, { actor, type, ...(payload !== undefined ? { payload } : {}) });
  };

  it("carries the model while no agent edit has followed the entry", async () => {
    log("agent", LogEventType.DraftPending, { model: "Opus 5.5" });
    log("agent", LogEventType.EditorPid, { pid: 1 });
    log("user", LogEventType.SettingsChanged, {}); // a human event does not deliver the draft
    expect((await session.load()).draftPending).toEqual({ model: "Opus 5.5" });
  });

  it("drops it once the agent's first edit has landed", async () => {
    log("agent", LogEventType.DraftPending, { model: "Opus 5.5" });
    log("agent", LogEventType.DocumentEdited, { bytes: 20 });
    expect((await session.load()).draftPending).toBeUndefined();
  });

  it("is absent for a document no agent created, and for an entry without a usable model", async () => {
    expect((await session.load()).draftPending).toBeUndefined();
    log("agent", LogEventType.DraftPending, { model: "  " });
    expect((await session.load()).draftPending).toBeUndefined();
  });
});
