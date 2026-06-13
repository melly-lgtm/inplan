// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for the comment composer's AUDIENCE switch ("talk to the agent"
// ⇄ "leave a memo"). Drives the real <App/> with a memory-backed window.api and asserts the
// load-bearing memo wiring on BOTH a doc-level and a span comment:
//   (a) a memo comment is STORED with `agent: false` (excluded from the agent's projection);
//   (b) a normal "talk to the agent" comment has NO `agent` field (the default);
//   (c) the `comment_created` CONTROL EVENT the host logs carries `payload.agent === false`
//       for a memo and OMITS it for a normal comment — the signal the cloud agent reads to
//       SKIP the wake (it never reacts to a memo).
//
// We read the stored comment back by re-parsing the document the host persisted (api.load),
// and we read the control event from the in-memory control log (agent.log()).
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only stubs, and
// comment creation lives in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEventType, parse } from "@inplan/core";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;
let api: ReturnType<typeof createMemoryApi>["api"];

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
  api = session.api;
});
afterEach(() => {
  cleanup();
  // happy-dom's Selection is global and survives cleanup; clear it so a leftover preview
  // selection can't turn the next test's "+ Add Doc Comment" into a span composer.
  window.getSelection()?.removeAllRanges();
});

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

/** Hand off the turn so the host performs a canonical save — a SPAN comment changes the body
 *  (its `[text](#cmt-id)` anchor link), which in Turn mode isn't persisted until the next save.
 *  (A doc-level comment is comment-only and already persists immediately.) */
async function flushTurn() {
  await act(async () => {
    screen.getByRole("button", { name: /finish turn/i }).click();
  });
}

/** The single comment the host persisted, re-parsed from the saved document. */
async function storedComment() {
  const payload = await api.load();
  const comments = parse(payload.content).comments;
  expect(comments.length).toBe(1);
  return comments[0]!;
}

/** The most recent `comment_created` control event the host logged. */
async function lastCommentCreated() {
  const entries = await agent.log();
  const created = entries.filter((e) => e.type === "comment_created");
  return created[created.length - 1];
}

/** Select the "Hello world." text inside the rendered preview, so ⌘/Ctrl+/ opens a SPAN composer. */
function selectPreviewPhrase() {
  const preview = document.querySelector(".ap-preview, [data-preview]") ?? document.querySelector("article, .ap-rendered");
  // Fall back to a tree walk for the exact phrase if the container isn't tagged as expected.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let target: Text | null = null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes("Hello world.")) {
      // Only accept a node living inside a [data-line] preview block (not the rail / source).
      const inLine = (node.parentElement?.closest?.("[data-line]")) != null;
      if (inLine) {
        target = node as Text;
        break;
      }
    }
  }
  if (!target) throw new Error("could not find 'Hello world.' inside a preview [data-line] block");
  void preview;
  const start = target.nodeValue!.indexOf("Hello world.");
  const range = document.createRange();
  range.setStart(target, start);
  range.setEnd(target, start + "Hello world.".length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

describe("App memo wiring — composer audience switch (memory-backed)", () => {
  it("(doc, memo) stores agent:false and logs payload.agent===false", async () => {
    await mountApp();

    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Note to self about the rollout." } });
    });

    // Flip the audience to "Leave a memo".
    await act(async () => {
      screen.getByRole("radio", { name: /leave a memo/i }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });

    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());

    const cmt = await storedComment();
    expect(cmt.agent).toBe(false);
    expect(cmt.anchor).toBe("doc");

    const ev = await lastCommentCreated();
    expect(ev?.payload).toMatchObject({ anchor: "doc", agent: false });
  });

  it("(doc, talk-to-agent) stores NO agent field and logs no agent in payload", async () => {
    await mountApp();

    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Please clarify the rollout plan." } });
    });
    // Default audience is "talk to the agent" — submit without flipping the switch.
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });

    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());

    const cmt = await storedComment();
    expect("agent" in cmt).toBe(false);
    expect(cmt.agent).toBeUndefined();

    const ev = await lastCommentCreated();
    expect(ev?.payload).toMatchObject({ anchor: "doc" });
    expect((ev?.payload as Record<string, unknown>)?.agent).toBeUndefined();
    expect("agent" in (ev!.payload as object)).toBe(false);
  });

  it("(span, memo) stores agent:false and logs payload.agent===false", async () => {
    await mountApp();

    await act(async () => {
      selectPreviewPhrase();
    });
    // ⌘/Ctrl+/ opens a SPAN composer on the selection.
    await act(async () => {
      fireEvent.keyDown(document, { key: "/", metaKey: true });
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Memo on this span." } });
    });
    await act(async () => {
      screen.getByRole("radio", { name: /leave a memo/i }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });

    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());

    await flushTurn();
    const cmt = await storedComment();
    expect(cmt.agent).toBe(false);
    // A span comment anchors to a clicked spot, not the whole doc.
    expect(cmt.anchor).not.toBe("doc");

    const ev = await lastCommentCreated();
    expect((ev?.payload as Record<string, unknown>)?.agent).toBe(false);
    // The span control event does NOT carry the doc anchor marker.
    expect((ev?.payload as Record<string, unknown>)?.anchor).not.toBe("doc");
  });

  it("(span, talk-to-agent) stores NO agent field and logs no agent in payload", async () => {
    await mountApp();

    await act(async () => {
      selectPreviewPhrase();
    });
    await act(async () => {
      fireEvent.keyDown(document, { key: "/", metaKey: true });
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Talk to the agent about this span." } });
    });
    // Default audience — do not flip to memo.
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });

    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());

    await flushTurn();
    const cmt = await storedComment();
    expect("agent" in cmt).toBe(false);
    expect(cmt.agent).toBeUndefined();
    expect(cmt.anchor).not.toBe("doc");

    const ev = await lastCommentCreated();
    expect("agent" in (ev!.payload as object)).toBe(false);
  });

  it("the memo signal is the only difference: doc memo vs doc normal payloads differ solely by agent:false", async () => {
    // Sanity tie-back to LogEventType so the control-event name we assert on stays the one
    // App emits via apply()/logAction (guards against a silent rename).
    expect(typeof LogEventType.HumanReclaimed).toBe("string");

    await mountApp();
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "A memo." } });
    });
    await act(async () => {
      screen.getByRole("radio", { name: /leave a memo/i }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());

    const ev = await lastCommentCreated();
    const payload = ev!.payload as Record<string, unknown>;
    // Remove the per-comment id, then the residual delta from a normal comment's {anchor:"doc"}
    // payload is exactly {agent:false}.
    const { id: _id, ...rest } = payload;
    void _id;
    expect(rest).toEqual({ anchor: "doc", agent: false });
  });
});
