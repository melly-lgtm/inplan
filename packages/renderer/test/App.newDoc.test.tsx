// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Create Doc / Move Text to New Doc: the context items appear only with a selection + a host
// that can create docs; choosing one opens the modal, the host create() runs, and the selection
// becomes a link. happy-dom can't make a real selection, so window.getSelection is mocked.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let create: ReturnType<typeof vi.fn>;
let append: ReturnType<typeof vi.fn>;
let agent: MemoryAgent;
let origGetSelection: typeof window.getSelection;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  agent = session.agent;
  create = vi.fn(async (path: string) => ({ status: "created" as const, linkTarget: path }));
  append = vi.fn(async (path: string) => ({ linkTarget: path }));
  (session.api as unknown as { newDoc: unknown }).newDoc = { pickPath: vi.fn(async () => null), create, append };
  (window as unknown as { api: unknown }).api = session.api;
  origGetSelection = window.getSelection;
});
afterEach(() => {
  window.getSelection = origGetSelection;
  cleanup();
});

function mockSelection(text: string) {
  const range = { cloneRange: () => range, getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }) } as unknown as Range;
  window.getSelection = (() => ({ toString: () => text, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;
}

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("new-doc actions", () => {
  it("offers Create Doc / Move Text to New Doc only with a selection + a host that can create", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    expect(screen.getByRole("menuitem", { name: /create doc/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /move blocks to new doc/i })).toBeTruthy();
  });

  it("Create Doc: opens the modal, calls host.create, and links the selection in place", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    // Modal: title + filename pre-filled from the selection.
    const path = (await screen.findByDisplayValue("hello_world.md")) as HTMLInputElement;
    expect(path).toBeTruthy();
    await act(async () => void screen.getByRole("button", { name: /^create$/i }).click());
    await waitFor(() => expect(create).toHaveBeenCalledWith("hello_world.md", expect.stringContaining("# Hello world.")));
    // The selection turned into a link to the new doc.
    await waitFor(() => expect(document.querySelector(".ap-rendered a")).toBeTruthy());
  });

  it("hides the Browse button when the host has no pickPath (e.g. web)", async () => {
    delete (window as unknown as { api: { newDoc: { pickPath?: unknown } } }).api.newDoc.pickPath; // host without a file browser
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    await screen.findByRole("button", { name: /^create$/i }); // modal still opens
    expect(screen.queryByRole("button", { name: /browse/i })).toBeNull();
  });

  it("Move: the new doc gets just the moved body — no synthetic title heading", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /move blocks to new doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^move$/i })).click());
    await waitFor(() => expect(create).toHaveBeenCalled());
    const content = create.mock.calls[0]![1] as string;
    expect(content).toContain("Hello world."); // the moved body
    expect(content).not.toMatch(/^#\s/m); // no "# Title" heading prepended
    // The original now links to the new doc (the moved text was replaced).
    await waitFor(() => expect(document.querySelector(".ap-rendered a")).toBeTruthy());
  });

  it("Move carries a span comment inside the moved block into the new doc (and drops it from the original)", async () => {
    // A doc whose movable paragraph (source line 2) holds an anchored comment.
    const withComment =
      "# Plan\n\nUse [Postgres](#cmt-pg) for storage.\n\n<!--inplan v1\n" +
      JSON.stringify([{ id: "cmt-pg", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "why postgres?" }]) +
      "\n-->\n";
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: withComment });
    create = vi.fn(async (path: string) => ({ status: "created" as const, linkTarget: path }));
    (session.api as unknown as { newDoc: unknown }).newDoc = { create };
    (window as unknown as { api: unknown }).api = session.api;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("why postgres?"));

    // Select the rendered paragraph block (data-line 2) — a real range so selectionSourceSpan
    // resolves a block line span (Move extracts whole source lines, anchor included).
    const para = Array.from(document.querySelectorAll(".ap-rendered [data-line]")).find((el) => el.getAttribute("data-line") === "2")!;
    const range = { startContainer: para, endContainer: para, cloneRange: () => range, getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }) } as unknown as Range;
    window.getSelection = (() => ({ toString: () => para.textContent ?? "", rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;

    await act(async () => void fireEvent.contextMenu(para));
    await act(async () => void screen.getByRole("menuitem", { name: /move blocks to new doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^move$/i })).click());

    await waitFor(() => expect(create).toHaveBeenCalled());
    const content = create.mock.calls[0]![1] as string;
    expect(content).toContain("[Postgres](#cmt-pg)"); // the anchor moved with the block
    expect(content).toContain("why postgres?"); // its comment thread rode along
    // The original lost the moved comment (the rail no longer shows it).
    await waitFor(() => expect(document.body.textContent).not.toContain("why postgres?"));
  });

  it("Create Doc on an existing file: warns, then links to it instead of silently failing", async () => {
    create.mockResolvedValue({ status: "exists", linkTarget: "hello_world.md" });
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^create$/i })).click());
    // The modal stays open and offers to link (rather than failing silently).
    await act(async () => void (await screen.findByRole("button", { name: /link to it/i })).click());
    await waitFor(() => expect(document.querySelector(".ap-rendered a")).toBeTruthy());
    expect(create).toHaveBeenCalledTimes(1); // only the probing attempt; never clobbered
  });

  it("Move Blocks onto an existing file: appends the blocks (default) and links the original", async () => {
    create.mockResolvedValue({ status: "exists", linkTarget: "hello_world.md" });
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /move blocks to new doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^move$/i })).click());
    // Append is checked by default → the action becomes Append; confirming appends into the existing doc.
    await act(async () => void (await screen.findByRole("button", { name: /^append$/i })).click());
    await waitFor(() => expect(append).toHaveBeenCalledWith("hello_world.md", expect.stringContaining("Hello world."), expect.any(Array)));
    await waitFor(() => expect(document.querySelector(".ap-rendered a")).toBeTruthy());
  });

  it("⌘/Ctrl+S saves (the shortcut is bound)", async () => {
    await mountApp();
    await act(async () => void fireEvent.keyDown(document, { key: "s", metaKey: true }));
    await waitFor(() => expect(document.body.textContent).toMatch(/saved/i)); // "saved" / "checkpoint saved"
  });

  it("disables Create for an un-anchorable selection but ALLOWS Move (Move is less restrictive)", async () => {
    await mountApp();
    mockSelection("text that is not in the body"); // can't anchor a comment here
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    const createItem = screen.getByRole("menuitem", { name: /create doc/i }) as HTMLButtonElement;
    const moveItem = screen.getByRole("menuitem", { name: /move blocks to new doc/i }) as HTMLButtonElement;
    expect(createItem.disabled).toBe(true); // Create wraps in place → blocked when un-anchorable
    expect(moveItem.disabled).toBe(false); // Move extracts whole blocks → allowed
    // The disabled Create is a no-op (no modal, no host call).
    await act(async () => void createItem.click());
    expect(screen.queryByRole("button", { name: /^create$/i })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not clobber a newer doc if the agent rewrites it while create() is in flight", async () => {
    await mountApp();
    mockSelection("Hello world.");
    // Keep create() pending so we can rewrite the doc (a committed render) BEFORE it resolves —
    // mirroring the real interleaving of the external-change IPC and the create response.
    let resolveCreate: () => void = () => {};
    create.mockImplementation(() => new Promise<{ status: "created"; linkTarget: string }>((r) => { resolveCreate = () => r({ status: "created", linkTarget: "hello_world.md" }); }));
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^create$/i })).click());
    // create() is in flight; the agent rewrites the doc, dropping the selection.
    await act(async () => agent.externalChange("# Plan\n\nReplaced by the agent.\n\n<!--inplan v1\n[]\n-->\n"));
    // Now create resolves — the splice runs against the FRESH body, can't find the selection, aborts.
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Replaced by the agent."); // newer text survives
    expect(document.querySelector(".ap-rendered a")).toBeNull(); // no stale link spliced over it
    expect(screen.getByRole("button", { name: /^create$/i })).toBeTruthy(); // modal stays open to retry/cancel
  });
});
