// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An agent edit that LANDS arrives as an external change. Live fill (CLI) means that now happens
// while the human may be typing, which it never did before — landings used to fall on turn
// boundaries. Replacing the buffer deletes keystrokes that exist in no other copy; keeping it
// wholesale drops what the agent just wrote, and the agent writes QUESTIONS. Comments cannot
// conflict with prose, so they are taken and the body is left alone.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCommentStore } from "../src/commentStore";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

/** The latest onChange handed to the stubbed SourceEditor: calling it is a human keystroke. */
let emitEdit: ((body: string) => void) | null = null;

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onChange?: (body: string) => void }, ref: React.Ref<unknown>) {
    emitEdit = props.onChange ?? null;
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const COMMENT = JSON.stringify([
  { id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" },
]);
/** The agent corrects that same comment: same id, new text. */
const REVISED = JSON.stringify([
  { id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore — and by when? (corrected)" },
]);
/** A SPAN comment (no anchor field): its anchor link lives in the incoming body only. */
const SPAN = JSON.stringify([
  { id: "cmt-s1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, text: "Question about this span." },
]);
/** …and its correction: same span id, new text — still span, still anchored only in the body. */
const SPAN_REVISED = JSON.stringify([
  { id: "cmt-s1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, text: "Question about this span — corrected." },
]);
/** The agent suggests resolving its own question (drives the auto-resolve setting). */
const MAY_RESOLVE = JSON.stringify([
  { id: "cmt-r1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", may_resolve: true, text: "Incorporated your feedback — resolve this?" },
]);
/** …and then corrects it (no suggestion on the correction). */
const MAY_REVISED = JSON.stringify([
  { id: "cmt-r1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Incorporated your feedback — and one more thing (corrected)." },
]);
/** The resolved question, unchanged, plus an unrelated new one: a landing that carries the
 *  human's version through untouched must not erase their ownership of it. */
const RESOLVED_AND_NEW = JSON.stringify([
  { id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: true, anchor: "doc", text: "Which datastore should this use?" },
  { id: "cmt-n1", author: "Agent <a@b>", date: "2026-01-02T00:00:00Z", resolved: false, anchor: "doc", text: "An unrelated new question." },
]);
/** The question as saved once the human resolved it. */
const RESOLVED = JSON.stringify([
  { id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: true, anchor: "doc", text: "Which datastore should this use?" },
]);
const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
/** The agent asks a question: a comment-only landing, the case that motivates all of this. */
const ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${COMMENT}\n-->\n`;
/** …and one that also rewrites the body. */
const ASKED_AND_REWROTE = `# Plan\n\nThe agent's rewritten body.\n\n<!--inplan v1\n${COMMENT}\n-->\n`;
/** The correction, landing on a buffer that already holds the original question. */
const ASKED_REVISED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${REVISED}\n-->\n`;
/** A span question — its anchor is in the incoming body, which a dirty buffer does not take. */
const SPAN_ASKED = `# Plan\n\nThe plan should [use Postgres](#cmt-s1).\n\n<!--inplan v1\n${SPAN}\n-->\n`;
const SPAN_REVISED_ASKED = `# Plan\n\nThe plan should [use Postgres](#cmt-s1).\n\n<!--inplan v1\n${SPAN_REVISED}\n-->\n`;
const MAY_ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${MAY_RESOLVE}\n-->\n`;
const MAY_REVISED_ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${MAY_REVISED}\n-->\n`;
const ASKED_RESOLVED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${RESOLVED}\n-->\n`;
const BOTH_ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${RESOLVED_AND_NEW}\n-->\n`;
const NEXT = "# Next\n\nThe document navigated to.\n\n<!--inplan v1\n[]\n-->\n";
/** A body-only landing: no comments at all. */
const BODY_ONLY = "# Plan\n\nThe agent rewrote the body and left no comments.\n\n<!--inplan v1\n[]\n-->\n";
/** A loaded document that already carries one comment (dated mid-2026). */
const C1 = JSON.stringify([{ id: "cmt-c1", author: "Agent <a@b>", date: "2026-06-01T00:00:00Z", resolved: false, anchor: "doc", text: "The older, loaded comment." }]);
const DOC_C1 = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${C1}\n-->\n`;
/** An arriving comment dated BEFORE the loaded one — canonical order puts it first. */
const EARLY = JSON.stringify([{ id: "cmt-early", author: "Agent <a@b>", date: "2025-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "The earlier-dated arrival." }]);
/** The same question with its JSON keys in a different order — semantically identical. */
const REORDERED = JSON.stringify([{ resolved: false, text: "Which datastore should this use?", id: "cmt-q1", anchor: "doc", date: "2026-01-01T00:00:00Z", author: "Agent <a@b>" }]);
const ASKED_REORDERED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${REORDERED}\n-->\n`;
/** The same landing with both: the arrival is dated BEFORE the loaded one — canonical order puts it first. */
const C1_AND_EARLY = JSON.stringify([
  { id: "cmt-c1", author: "Agent <a@b>", date: "2026-06-01T00:00:00Z", resolved: false, anchor: "doc", text: "The older, loaded comment." },
  { id: "cmt-early", author: "Agent <a@b>", date: "2025-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "The earlier-dated arrival." },
]);
const EARLY_ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${C1_AND_EARLY}\n-->\n`;
const MINE = "# Plan\n\nThe human's own sentence, not yet saved.\n";
let agent: MemoryAgent;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(() => {
  cleanup();
  emitEdit = null;
});

async function mountAndType() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("The original body."));
  await act(async () => {
    screen.getByRole("button", { name: /^Source$/ }).click(); // mount the stub, capture onChange
  });
  await waitFor(() => expect(emitEdit).toBeTruthy());
  await act(async () => {
    emitEdit?.(MINE); // typed, NOT saved
  });
  expect(document.body.textContent).toContain("unsaved");
}

describe("an agent edit landing on an unsaved buffer", () => {
  it("takes the agent's question, and leaves the human's sentence alone", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED);
    });

    expect(document.body.textContent).toContain("The agent left a comment"); // said, not silent
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail renders on its own tab
    });
    expect(document.body.textContent).toContain("Which datastore should this use?"); // it is really there
    expect(document.body.textContent).toContain("The human's own sentence"); // untouched
    expect(document.body.textContent).toContain("unsaved"); // still theirs to save
  });

  it("keeps the human's body when the agent rewrote it too, and says so", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED_AND_REWROTE);
    });

    expect(document.body.textContent).toContain("changed the body"); // and says the body is not shown
    expect(document.body.textContent).toContain("The human's own sentence");
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    expect(document.body.textContent).toContain("Which datastore should this use?"); // the question still arrives
    expect(document.body.textContent).not.toContain("The agent's rewritten body."); // not shown: see #131
  });

  it("an undo cannot remove the agent's question — it was not the human's work", async () => {
    // The human undoes their OWN comment while dirty; the popped snapshot predates the landing.
    // Without protecting the arrivals, undo erased the agent's question too, and Send then wrote
    // the erasure to the file — the stall this whole branch exists to prevent.
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // the human's own comment…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE); // …then typing, unsaved
    });
    await act(async () => {
      agent.externalChange(ASKED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("Which datastore should this use?"); // …not the agent's
  });

  it("…nor after a clean landing: undo steps back over the human's work, not the agent's", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      agent.externalChange(ASKED); // …then a clean landing (the comment save left the buffer clean)
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("Which datastore should this use?"); // …not the agent's
  });

  it("a repeat landing while still dirty does not duplicate the question", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED);
    });
    await act(async () => {
      agent.externalChange(ASKED); // the channel re-delivers the same turn
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    const occurrences = document.body.textContent!.split("Which datastore should this use?").length - 1;
    expect(occurrences).toBe(1);
  });

  it("a correction to a comment already in the buffer is taken, not dropped", async () => {
    // Only new ids used to be taken, so the agent's correction to its own earlier question
    // vanished — and the human's next save overwrote it on disk, unseen by anyone.
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED);
    });
    await act(async () => {
      agent.externalChange(ASKED_REVISED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).toContain("and by when? (corrected)");
    expect(document.body.textContent).not.toContain("Which datastore should this use?");
  });

  it("…but a comment the human has changed themselves keeps their version", async () => {
    await mountAndType();
    await act(async () => {
      agent.externalChange(ASKED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Resolve thread" }).click(); // the human resolves the question…
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?")); // …and it leaves the rail
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(`${MINE}\nStill thinking.\n`); // the resolve SAVED MINE, so type something new:
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved")); // …unsaved again
    await act(async () => {
      agent.externalChange(ASKED_REVISED); // the agent corrects the resolved question
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("(corrected)"); // the human's resolve stands
    expect(document.body.textContent).toContain("unsaved");
  });

  it("a span question whose anchor is not in the buffer arrives as a document comment", async () => {
    // The incoming body holds the anchor link, but a dirty buffer keeps its own body — so the
    // link may not exist here. An undemoted span with no anchor is HIDDEN by the rail; the
    // demotion is what makes the question visible at all.
    await mountAndType();

    await act(async () => {
      agent.externalChange(SPAN_ASKED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).toContain("Question about this span.");
  });

  it("on a store-backed host, the announcement counts what the RAIL gained, not the file's copy", async () => {
    // The store owns comments; the file projection the event carries can lag it. Counting the
    // file's comment block stayed silent about a question already visible in the rail.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    const store = createMemoryCommentStore([]); // empty at load — the turn is what fills it
    (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store };
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE);
    });

    await act(async () => {
      // The store delivers the question; the file projection the event carries lags it and has
      // no comment block at all. Same tick: the handler must read the store before any re-render.
      store.add({ id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" });
      agent.externalChange(DOC);
    });

    expect(document.body.textContent).toContain("The agent left a comment"); // said, not silent
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    expect(document.body.textContent).toContain("Which datastore should this use?"); // and it is
  });

  it("a corrected SPAN question stays visible: the taken revision is demoted like an arrival", async () => {
    // The first landing demotes the span (no anchor in the buffer). The correction is a span too,
    // anchored only in the body the dirty branch refuses — substituted verbatim it was hidden by
    // the rail while the status said it was there.
    await mountAndType();
    await act(async () => {
      agent.externalChange(SPAN_ASKED);
    });
    await act(async () => {
      agent.externalChange(SPAN_REVISED_ASKED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).toContain("Question about this span — corrected.");
    expect(document.body.textContent).not.toContain("Question about this span.");
  });

  it("on a store host whose observer flushed FIRST, undo still cannot remove the question", async () => {
    // The store delivers over its own channel; the file-projection event can arrive a task later,
    // after the observer already put the comment in the buffer. The arrivals must then be read
    // against the newest undo snapshot, not the live buffer — or undo would hand reconcileComments
    // a pre-arrival state and DELETE the agent's comment from the shared store.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    const store = createMemoryCommentStore([]);
    (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store };
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action: the undo stack exists
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE);
    });
    await act(async () => {
      store.add({ id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" });
    }); // the observer flushes — a SEPARATE task before the event
    await act(async () => {
      agent.externalChange(DOC);
    });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail is where comments show
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("Which datastore should this use?"); // still in the buffer…
    expect(store.list().some((c) => c.id === "cmt-q1")).toBe(true); // …and still in the shared store
  });

  it("undo cannot rewind a taken correction to its superseded text", async () => {
    await mountAndType();
    await act(async () => {
      agent.externalChange(ASKED); // the question lands, dirty: taken
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action AFTER…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(`${MINE}\nStill thinking.\n`); // …then typing, unsaved again
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));
    await act(async () => {
      agent.externalChange(ASKED_REVISED); // the correction is taken into the buffer
    });

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("and by when? (corrected)"); // the correction stands
    expect(document.body.textContent).not.toContain("Which datastore should this use?");
  });

  it("a thread the editor auto-resolved is not the human's: the agent's correction is still taken", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC, settings: { autoResolve: true } }); // the editor resolves may_resolve threads itself
    (window as unknown as { api: unknown }).api = session.api;
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      agent.externalChange(MAY_ASKED);
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Incorporated your feedback")); // auto-resolved → hidden
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(MINE); // unsaved, so the correction falls on the dirty branch
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));

    await act(async () => {
      agent.externalChange(MAY_REVISED_ASKED); // the agent corrects the auto-resolved question
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).toContain("one more thing (corrected)"); // taken, not refused
  });

  it("a comment the human deleted is not resurrected by a re-delivered turn", async () => {
    await mountAndType();
    await act(async () => {
      agent.externalChange(ASKED);
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));
    await act(async () => {
      screen.getByTitle("More").click(); // the thread's ⋯ menu
    });
    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?"));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(`${MINE}\nStill thinking.\n`); // unsaved again
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));

    await act(async () => {
      agent.externalChange(ASKED); // the channel re-delivers the same turn
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail is where it would show
    });

    expect(document.body.textContent).not.toContain("Which datastore should this use?"); // stays deleted
  });

  it("ownership of a resolved comment survives a document round-trip", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      agent.externalChange(ASKED); // clean take
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Resolve thread" }).click(); // the human resolves it…
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?"));
    await act(async () => {
      agent.navigate(NEXT, "memory://doc2"); // …visits another document…
    });
    await waitFor(() => expect(document.body.textContent).toContain("The document navigated to."));
    await act(async () => {
      agent.navigate(ASKED_RESOLVED, "memory://doc"); // …and returns (the file holds the resolve)
    });
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(MINE); // unsaved, so the next landing falls on the dirty branch
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));

    await act(async () => {
      agent.externalChange(ASKED_REVISED); // the agent corrects the resolved question
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail is where it would show
    });

    expect(document.body.textContent).not.toContain("(corrected)"); // the human's resolve stands
    expect(document.body.textContent).not.toContain("Which datastore should this use?"); // …still resolved, still hidden
  });

  it("…and a clean landing's corrections too: undo cannot rewind them either", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      agent.externalChange(ASKED); // …then a clean landing of the question…
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));
    await act(async () => {
      agent.externalChange(ASKED_REVISED); // …and of its correction
    });
    await waitFor(() => expect(document.body.textContent).toContain("and by when? (corrected)"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("and by when? (corrected)"); // the correction stands
    expect(document.body.textContent).not.toContain("Which datastore should this use?");
  });

  it("on a store host, a CLEAN landing whose observer flushed first is protected too", async () => {
    // A bound store host is never dirty from typing — this is its common landing path. Reading
    // the arrivals from the live buffer meant they were never noted, and undo then handed the
    // reconciler a pre-arrival state that DELETED the agent's comment from the shared store.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    const store = createMemoryCommentStore([]);
    (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store };
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      store.add({ id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" });
    }); // the observer flushes — a SEPARATE task before the event
    await act(async () => {
      agent.externalChange(DOC); // clean buffer: the store host's common landing
    });

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("Which datastore should this use?"); // still here…
    expect(store.list().some((c) => c.id === "cmt-q1")).toBe(true); // …and still in the shared store
  });

  it("undo cannot resurrect a comment the agent deleted", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    const store = createMemoryCommentStore([]);
    (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store };
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      store.add({ id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" });
    });
    await act(async () => {
      agent.externalChange(DOC); // the question lands (noted into the snapshots)
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));
    await act(async () => {
      store.replaceAll(store.list().filter((c) => c.id !== "cmt-q1")); // the agent deletes it…
    });
    await act(async () => {
      agent.externalChange(DOC); // …and the landing sees the deletion
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("My own note."); // the undo did its own work…
    expect(document.body.textContent).not.toContain("Which datastore should this use?"); // …without resurrecting the deletion
    expect(store.list().some((c) => c.id === "cmt-q1")).toBe(false); // …in the buffer OR the shared store
  });

  it("an auto-resolve while the human is typing does not save their half-typed body", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC, settings: { autoResolve: true } });
    (window as unknown as { api: unknown }).api = session.api;
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE); // mid-sentence, unsaved
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));

    await act(async () => {
      agent.externalChange(MAY_ASKED); // a may_resolve comment lands on the dirty buffer
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Incorporated your feedback")); // auto-resolved

    expect(document.body.textContent).toContain("unsaved"); // still theirs to save — the resolve rode along
    const persisted = await (window as unknown as { api: { load: () => Promise<{ content: string }> } }).api.load();
    expect(persisted.content).not.toContain("The human's own sentence"); // nothing half-typed on disk
  });

  it("a clean landing that carries the human's version through unchanged keeps their ownership", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      agent.externalChange(ASKED); // the question lands
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Resolve thread" }).click(); // the human resolves it
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?"));
    await act(async () => {
      agent.externalChange(BOTH_ASKED); // a clean landing carrying their resolve through, plus a new one
    });
    await waitFor(() => expect(document.body.textContent).toContain("An unrelated new question."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await act(async () => {
      emitEdit?.(MINE); // unsaved, so the next landing falls on the dirty branch
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));

    await act(async () => {
      agent.externalChange(ASKED_REVISED); // the agent corrects the resolved question
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("(corrected)"); // their version was carried, so it stands
  });

  it("on a store host, undo cannot rewind a REVISED comment out of the shared store", async () => {
    // The delta used to compare id-sets only, so a revision to an existing id was never settled:
    // every snapshot kept the superseded text, and undo wrote it back to the shared store.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    const store = createMemoryCommentStore([]);
    (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store };
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      store.add({ id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, anchor: "doc", text: "Which datastore should this use?" });
    });
    await act(async () => {
      agent.externalChange(DOC); // the question lands
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));
    await act(async () => {
      store.replaceAll(store.list().map((c) => (c.id === "cmt-q1" ? { ...c, text: "Which datastore — and by when? (corrected)" } : c))); // the agent corrects it
    });
    await act(async () => {
      agent.externalChange(DOC); // …and the landing sees the correction
    });
    await waitFor(() => expect(document.body.textContent).toContain("and by when? (corrected)"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("and by when? (corrected)"); // the correction stands…
    const stored = store.list().find((c) => c.id === "cmt-q1");
    expect(stored?.text).toContain("(corrected)"); // …in the buffer AND the shared store
  });

  it("on a FILE host too, undo cannot resurrect a comment the agent deleted", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      agent.externalChange(ASKED); // the question lands
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore should this use?"));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action after it
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      agent.externalChange(DOC); // the agent's next turn carries no comment: it deleted it
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Which datastore should this use?"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });

    expect(document.body.textContent).not.toContain("My own note."); // the undo did its own work…
    expect(document.body.textContent).not.toContain("Which datastore should this use?"); // …without resurrecting the deletion
  });

  it("a re-delivered turn does not re-announce a comment the rail already holds", async () => {
    await mountAndType();
    await act(async () => {
      agent.externalChange(ASKED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("The agent left a comment"));

    await act(async () => {
      agent.externalChange(ASKED); // the channel re-delivers the same turn
    });

    expect(document.body.textContent).not.toContain("The agent left a comment"); // nothing new arrived
    expect(document.body.textContent).toContain("Save or reopen"); // the honest fallback
  });

  it("a body-only landing on an unsaved buffer keeps the sentence and says so plainly", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(BODY_ONLY);
    });

    expect(document.body.textContent).toContain("Save or reopen"); // no comment to point at
    expect(document.body.textContent).not.toContain("The agent left a comment");
    expect(document.body.textContent).toContain("The human's own sentence");
    expect(document.body.textContent).not.toContain("rewrote the body and left no comments");
  });

  it("a re-delivered turn does not revert a resolve that rode unsaved", async () => {
    // The auto-resolve persisted nothing (it must not, while the human is mid-sentence), so the
    // file still holds the unresolved copy — re-delivering it used to pop the thread back open,
    // and it could never auto-resolve again.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC, settings: { autoResolve: true } });
    (window as unknown as { api: unknown }).api = session.api;
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE); // mid-sentence, unsaved
    });
    await waitFor(() => expect(document.body.textContent).toContain("unsaved"));
    await act(async () => {
      agent.externalChange(MAY_ASKED); // a may_resolve comment lands and is auto-resolved
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Incorporated your feedback"));

    await act(async () => {
      agent.externalChange(MAY_ASKED); // the same turn re-delivered, still unsaved
    });

    expect(document.body.textContent).not.toContain("Incorporated your feedback"); // still resolved
    expect(document.body.textContent).toContain("Save or reopen"); // and nothing claimed to arrive again
    expect(document.body.textContent).toContain("unsaved");
  });

  it("a patched snapshot keeps canonical comment order, not arrival order", async () => {
    // A snapshot patched by appending serialized the arrival LAST even when it sorts FIRST, so
    // undoing to it read back as a change that was only order — a spurious dirty flag and an
    // autosave churning the comment block.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC_C1 });
    (window as unknown as { api: unknown }).api = session.api;
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The older, loaded comment."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      agent.externalChange(EARLY_ASKED); // …then an earlier-dated comment lands
    });
    await waitFor(() => expect(document.body.textContent).toContain("The earlier-dated arrival."));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });

    const text = document.body.textContent ?? "";
    expect(text.indexOf("The earlier-dated arrival.")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("The earlier-dated arrival.")).toBeLessThan(text.indexOf("The older, loaded comment.")); // canonical, not appended
  });

  it("undo cannot hide a demoted SPAN question: what lands in a snapshot is anchored in THAT snapshot's body", async () => {
    // The settle list carried the raw incoming span while the buffer got the demoted copy, so
    // the snapshot held an anchorless span — undo hid the question and autosave could persist
    // the invalid state.
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click(); // an app-level action…
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE); // …then typing, unsaved
    });
    await act(async () => {
      agent.externalChange(SPAN_ASKED); // a span question lands, demoted into the buffer
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Question about this span."));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment
    });

    expect(document.body.textContent).not.toContain("My own note."); // undone — it was the human's
    expect(document.body.textContent).toContain("Question about this span."); // …not the agent's
  });

  it("…nor on a clean landing, when the snapshot's body predates the anchor link", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      agent.externalChange(SPAN_ASKED); // clean landing: the body AND the span arrive together
    });
    await waitFor(() => expect(document.body.textContent).toContain("Question about this span."));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // undo MY comment → a body without the link
    });

    expect(document.body.textContent).not.toContain("My own note.");
    expect(document.body.textContent).toContain("Question about this span."); // demoted for that body, still visible
  });

  it("the dirty buffer's comments are kept in canonical order too, not insertion order", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC_C1 });
    (window as unknown as { api: unknown }).api = session.api;
    agent = session.agent;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The older, loaded comment."));
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "My own note." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("My own note."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click();
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(MINE);
    });
    await act(async () => {
      agent.externalChange(EARLY_ASKED); // an earlier-dated comment lands on the dirty buffer
    });
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("The earlier-dated arrival."));

    const text = document.body.textContent ?? "";
    expect(text.indexOf("The earlier-dated arrival.")).toBeLessThan(text.indexOf("The older, loaded comment.")); // canonical, not appended
  });

  it("a re-delivered demoted span does not re-announce: it is compared as this buffer holds it", async () => {
    // The buffer holds the demoted doc copy; the re-delivered incoming is the raw span. Compared
    // raw, nothing matched and a no-op turn was announced as a new comment.
    await mountAndType();
    await act(async () => {
      agent.externalChange(SPAN_ASKED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("The agent left a comment"));

    await act(async () => {
      agent.externalChange(SPAN_ASKED); // the same turn, re-delivered unchanged
    });

    expect(document.body.textContent).not.toContain("The agent left a comment"); // nothing new
    expect(document.body.textContent).toContain("Save or reopen");
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail is where it shows
    });
    expect(document.body.textContent).toContain("Question about this span."); // …and it stayed
  });

  it("a re-ordered copy of a comment is the same comment, not a revision", async () => {
    // Comments cross store boundaries where JSON key order is not preserved; a raw stringify
    // comparison re-announced a semantically identical landing as a new revision.
    await mountAndType();
    await act(async () => {
      agent.externalChange(ASKED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("The agent left a comment"));

    await act(async () => {
      agent.externalChange(ASKED_REORDERED); // same values, keys in a different order
    });

    expect(document.body.textContent).not.toContain("The agent left a comment"); // nothing new
    expect(document.body.textContent).toContain("Save or reopen");
  });

  it("takes the agent's edit outright when the buffer is clean — the normal case is unchanged", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));

    await act(async () => {
      agent.externalChange(ASKED_AND_REWROTE);
    });

    await waitFor(() => expect(document.body.textContent).toContain("The agent's rewritten body."));
  });
});
