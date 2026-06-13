// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A behavior matrix for the find bar's N/M match count against the real <App/>
// with a memory-backed window.api. Exercises the count text the bar renders
// (`${Math.min(idx+1, n)}/${n}` or "0/0") across: match counts, the
// case-insensitive ("Aa") toggle, no-match queries, the preview/editor/comments
// scopes, clearing the query, comment-only matches, and special-regex chars
// (escapeRegExp makes them literal — no crash).
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and the find flow under test lives in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// Build a serialized inplan document: a body plus a comment data block holding
// the given comments (each needs at least id/text/author). The find bar counts
// comment matches straight off doc.comments, so this is enough to drive it.
function makeDoc(body: string, comments: Array<{ id: string; text: string }> = []): string {
  const json = JSON.stringify(comments.map((c) => ({ id: c.id, text: c.text, author: "tester" })), null, 2);
  return `${body}\n\n<!--inplan v1\n${json}\n-->\n`;
}

// "alpha" appears 3 times in the body; "Alpha" (capital) appears once. The body
// also carries a "." so a literal "." query is meaningful, and a unicode word.
const BODY = "# Plan\n\nalpha beta alpha gamma alpha delta. Alpha café (x).\n";
// "zephyr" lives only in a comment, never in the body.
const DOC = makeDoc(BODY, [{ id: "c1", text: "zephyr note about alpha" }]);

let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}

afterEach(cleanup);

async function openFindBar(content: string) {
  mount(content);
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("alpha beta alpha"));
  expect(screen.queryByPlaceholderText(/Find/)).toBeNull();
  fireEvent.keyDown(document.body, { key: "f", metaKey: true });
  const input = await waitFor(() => screen.getByPlaceholderText("Find…"));
  return input;
}

async function type(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

// jest-dom matchers aren't wired into this suite; read .checked off the element.
function checkbox(name: RegExp): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

describe("App find bar — match-count matrix (memory-backed)", () => {
  it("renders N/M for a query with multiple body matches (1/3, case-sensitive)", async () => {
    const input = await openFindBar(DOC);
    await type(input, "alpha");
    // Default scope is preview (= body) and case-sensitive, so capital "Alpha"
    // is NOT counted: exactly three lowercase "alpha".
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));
    expect(document.body.textContent).not.toContain("1/4");
  });

  it("shows 1/1 for a query with a single body match", async () => {
    const input = await openFindBar(DOC);
    await type(input, "gamma");
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));
  });

  it("shows 0/0 when nothing matches", async () => {
    const input = await openFindBar(DOC);
    await type(input, "nonexistent-token");
    await waitFor(() => expect(document.body.textContent).toContain("0/0"));
  });

  it("counts are case-sensitive by default and case-insensitive once Aa is toggled", async () => {
    const input = await openFindBar(DOC);
    // Capital "Alpha" appears once; lowercase "alpha" three times.
    await type(input, "Alpha");
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));

    // Toggle the case checkbox (label text "Aa"). Now "Alpha" matches all four
    // (3 lowercase + 1 capital).
    const aa = screen.getByRole("checkbox", { name: /aa/i });
    await act(async () => {
      fireEvent.click(aa);
    });
    await waitFor(() => expect(document.body.textContent).toContain("1/4"));

    // Toggling back restores the case-sensitive count.
    await act(async () => {
      fireEvent.click(aa);
    });
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));
  });

  it("clearing the query resets the count to 0/0", async () => {
    const input = await openFindBar(DOC);
    await type(input, "alpha");
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));
    await type(input, "");
    await waitFor(() => expect(document.body.textContent).toContain("0/0"));
  });

  it("preview and editor scopes both search the body (mutually exclusive, same count)", async () => {
    const input = await openFindBar(DOC);
    await type(input, "alpha");
    // Default = preview scope → body matches.
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));

    // Switch to the editor scope; preview turns off (preview ⊕ editor) but the
    // body is still what's scanned, so the count is unchanged.
    const editor = screen.getByRole("checkbox", { name: /editor/i });
    await act(async () => {
      fireEvent.click(editor);
    });
    await waitFor(() => expect(checkbox(/editor/i).checked).toBe(true));
    expect(checkbox(/preview/i).checked).toBe(false);
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));
  });

  it("with NO body/comment scope active there are 0 matches even though the body contains the query", async () => {
    const input = await openFindBar(DOC);
    await type(input, "alpha");
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));

    // Turn off preview without enabling editor/comments → nothing is scanned.
    const preview = screen.getByRole("checkbox", { name: /preview/i });
    await act(async () => {
      fireEvent.click(preview);
    });
    await waitFor(() => expect(checkbox(/preview/i).checked).toBe(false));
    await waitFor(() => expect(document.body.textContent).toContain("0/0"));
  });

  it("comments scope adds comment matches; a comment-only word matches only when comments are searched", async () => {
    const input = await openFindBar(DOC);
    // "zephyr" lives in the comment, not the body → 0/0 under the default
    // (preview/body) scope.
    await type(input, "zephyr");
    await waitFor(() => expect(document.body.textContent).toContain("0/0"));

    // Enable the comments scope → the comment match is now counted.
    const comments = screen.getByRole("checkbox", { name: /comments/i });
    await act(async () => {
      fireEvent.click(comments);
    });
    await waitFor(() => expect(checkbox(/comments/i).checked).toBe(true));
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));
  });

  it("preview + comments together sum body and comment matches", async () => {
    const input = await openFindBar(DOC);
    // "alpha": 3 in the body, 1 in the comment ("...about alpha").
    await type(input, "alpha");
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));

    const comments = screen.getByRole("checkbox", { name: /comments/i });
    await act(async () => {
      fireEvent.click(comments);
    });
    await waitFor(() => expect(checkbox(/comments/i).checked).toBe(true));
    await waitFor(() => expect(document.body.textContent).toContain("1/4"));
  });

  it("special regex chars are treated literally (no crash, accurate count)", async () => {
    const input = await openFindBar(DOC);
    // "." would match every char as a regex; escapeRegExp makes it literal.
    // The body has exactly two literal "." characters ("delta." and "(x).").
    await type(input, ".");
    await waitFor(() => expect(document.body.textContent).toContain("1/2"));

    // "(x)" — parens are regex metacharacters; treated literally it matches the
    // single "(x)" substring in the body.
    await type(input, "(x)");
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));

    // A query of only metacharacters that appears nowhere → 0/0, still no crash.
    await type(input, "[unmatched");
    await waitFor(() => expect(document.body.textContent).toContain("0/0"));
  });

  it("a whitespace-only query is still counted literally", async () => {
    const input = await openFindBar(DOC);
    // The body has multiple single spaces; a single-space query is a real
    // (non-empty) literal query, so it produces a positive count rather than 0/0.
    await type(input, " ");
    // The (trimmed) body "# Plan\n\nalpha beta alpha gamma alpha delta. Alpha
    // café (x)." contains exactly 9 space characters (1 in "# Plan" + 8 in the
    // text line) → 1/9, never 0/0.
    await waitFor(() => expect(document.body.textContent).toContain("1/9"));
    expect(document.body.textContent).not.toContain("0/0");
  });

  it("unicode in the body is matched literally", async () => {
    const input = await openFindBar(DOC);
    await type(input, "café");
    await waitFor(() => expect(document.body.textContent).toContain("1/1"));
  });

  it("agent is wired up by the memory session (sanity)", () => {
    expect(agent).toBeTruthy();
  });
});
