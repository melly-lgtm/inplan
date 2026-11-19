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
const NEXT = "# Next\n\nThe document navigated to.\n\n<!--inplan v1\n[]\n-->\n";
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
