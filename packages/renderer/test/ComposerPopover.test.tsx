// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPopover } from "../src/ComposerPopover";
import { MOD_KEY } from "../src/platform";
import { setHostApi, type Api } from "../src/api";
import { resetMentionRoster } from "../src/mentionAutocomplete";

afterEach(() => {
  cleanup();
  setHostApi(undefined as unknown as Api); // reset any mention-roster stub between tests
  resetMentionRoster(); // the roster is cached module-level (shared across composers) — must not leak between tests
});

const base = { target: null as string | null, pos: { x: 10, y: 10 }, disabled: false, onSubmit: () => {}, onClose: () => {} };
const textarea = () => screen.getByPlaceholderText(/Add a comment/) as HTMLTextAreaElement;
const commentBtn = () => screen.getByRole("button", { name: /^comment$/i }) as HTMLButtonElement;

describe("ComposerPopover", () => {
  it("shows the anchored target, or a document-level label", () => {
    const { rerender } = render(<ComposerPopover {...base} target="use Postgres" />);
    expect(document.body.textContent).toContain("use Postgres");
    rerender(<ComposerPopover {...base} target={null} />);
    expect(document.body.textContent).toContain("document-level comment");
  });

  it("submits trimmed text on ⌘/Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "  a remark  " } });
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("a remark", true, []); // default audience = talk to the agent
  });

  it("Comment button is disabled until there's text, then submits", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    expect(commentBtn().disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: "hi" } });
    expect(commentBtn().disabled).toBe(false);
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("hi", true, []);
  });

  it("the audience switch defaults to 'talk to the agent'; choosing 'leave a memo' submits agent=false", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    const memo = screen.getByRole("radio", { name: /leave a memo/i });
    const talk = screen.getByRole("radio", { name: /talk to the agent/i });
    expect(talk.getAttribute("aria-checked")).toBe("true"); // conversation is the default
    expect(memo.getAttribute("aria-checked")).toBe("false");
    fireEvent.change(textarea(), { target: { value: "note to self" } });
    fireEvent.click(memo); // switch to memo
    expect(memo.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("note to self", false, []); // memo → the agent ignores it
  });

  it("shows the OS-specific modifier in the placeholder, not the dual 'Cmd/Ctrl'", () => {
    render(<ComposerPopover {...base} />);
    const ph = textarea().placeholder;
    expect(ph).toContain(`${MOD_KEY}+Enter`);
    expect(ph).not.toContain("/Ctrl"); // no longer the dual "⌘/Ctrl" form
  });

  it("cancel closes without submitting", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drags via the header, and only dismisses on an outside click when empty", () => {
    const onClose = vi.fn();
    render(<ComposerPopover {...base} onClose={onClose} />);
    const head = document.querySelector(".ap-composer-head") as HTMLElement;
    fireEvent.mouseDown(head, { clientX: 50, clientY: 50 }); // start drag
    fireEvent.mouseMove(document, { clientX: 80, clientY: 90 }); // moves the popover (setP)
    fireEvent.mouseUp(document); // end drag
    // Outside click with text present must NOT dismiss (don't discard a draft).
    fireEvent.change(textarea(), { target: { value: "draft" } });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    // Emptied → an outside click dismisses.
    fireEvent.change(textarea(), { target: { value: "" } });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an @-mention dropdown from the host roster and submits the picked email", async () => {
    const onSubmit = vi.fn();
    setHostApi({
      listMentionableUsers: async () => [
        { email: "bob@example.com", name: "Bob" },
        { email: "alice@example.com" },
      ],
    } as unknown as Api);
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "hey @bo" } });
    await screen.findByText("bob@example.com");
    expect(screen.queryByText("alice@example.com")).toBeNull(); // filtered out — doesn't match "bo"
    fireEvent.mouseDown(screen.getByText("bob@example.com"));
    expect(textarea().value).toBe("hey @bob@example.com ");
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("hey @bob@example.com", true, ["bob@example.com"]);
  });

  it("does not call listMentionableUsers until the author actually types an @-trigger", () => {
    const listMentionableUsers = vi.fn().mockResolvedValue([{ email: "bob@example.com" }]);
    setHostApi({ listMentionableUsers } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "just typing, no trigger yet" } });
    expect(listMentionableUsers).not.toHaveBeenCalled();
    fireEvent.change(textarea(), { target: { value: "just typing, no trigger yet @b" } });
    expect(listMentionableUsers).toHaveBeenCalledTimes(1);
  });

  it("only counts a mention as active while it's still a COMPLETE @email token (an edited/extended one doesn't count)", async () => {
    const onSubmit = vi.fn();
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await screen.findByText("bob@example.com");
    fireEvent.mouseDown(screen.getByText("bob@example.com"));
    // Hand-extend the picked mention into a different address — no longer a complete token.
    fireEvent.change(textarea(), { target: { value: "hey @bob@example.comx typo" } });
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("hey @bob@example.comx typo", true, []);
  });

  it.each([
    ["hey @bob@example.com, please look", "trailing comma"],
    ["hey @bob@example.com. thanks", "trailing period"],
    ["hey @bob@example.com!", "trailing exclamation"],
  ])("still counts a mention followed by prose punctuation (%s)", async (edited, _label) => {
    const onSubmit = vi.fn();
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await screen.findByText("bob@example.com");
    fireEvent.mouseDown(screen.getByText("bob@example.com"));
    fireEvent.change(textarea(), { target: { value: edited } });
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith(edited, true, ["bob@example.com"]);
  });

  it("a transient roster fetch failure does not permanently cache 'no roster' for the rest of the session", async () => {
    setHostApi({
      listMentionableUsers: async () => {
        throw new Error("network blip");
      },
    } as unknown as Api);
    const { unmount } = render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await new Promise((r) => setTimeout(r, 0)); // let the rejected fetch settle
    expect(document.querySelector(".ap-mention-dropdown")).toBeNull(); // failed this time
    unmount();

    // A LATER composer instance (a fresh mount — the reply box, or reopening this one) must
    // retry rather than keep reusing an empty roster cached from the earlier failure.
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await screen.findByText("bob@example.com");
  });

  it("a failed roster fetch lets the SAME still-mounted composer retry on its next @-trigger", async () => {
    let calls = 0;
    setHostApi({
      listMentionableUsers: async () => {
        calls++;
        if (calls === 1) throw new Error("first attempt fails");
        return [{ email: "bob@example.com" }];
      },
    } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } }); // 1st attempt: fails
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".ap-mention-dropdown")).toBeNull();
    expect(calls).toBe(1);

    // Still the SAME textarea — a genuinely different value (the author kept typing), since
    // firing an identical value again wouldn't register as a real change to react-dom's tracker.
    fireEvent.change(textarea(), { target: { value: "hey @bo" } });
    await screen.findByText("bob@example.com");
    expect(calls).toBe(2);
  });

  it("a roster request pending across a navigation cannot restore stale users into the shared cache", async () => {
    let resolveFirst!: (u: { email: string }[]) => void;
    const firstFetch = new Promise<{ email: string }[]>((res) => {
      resolveFirst = res;
    });
    setHostApi({ listMentionableUsers: () => firstFetch } as unknown as Api);
    const { unmount } = render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } }); // kicks off the pending fetch

    resetMentionRoster(); // simulate in-window navigation to a different doc WHILE it's in flight
    unmount(); // the old doc's composer is gone too — navigation replaces the whole doc/rail

    // The stale request resolves only now, with the OLD doc's roster — after the nav already reset.
    resolveFirst([{ email: "old-doc-user@example.com" }]);
    await new Promise((r) => setTimeout(r, 0));

    // A fresh composer instance for the NEW doc must get a real fetch of ITS OWN roster, not the
    // stale result the obsolete request tried to write into the shared cache.
    setHostApi({ listMentionableUsers: async () => [{ email: "new-doc-user@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @n" } });
    await screen.findByText("new-doc-user@example.com");
    expect(screen.queryByText("old-doc-user@example.com")).toBeNull();
  });

  it("an obsolete request settling while a NEWER request is still pending does not clear the newer one", async () => {
    let resolveOld!: (u: { email: string }[]) => void;
    const oldFetch = new Promise<{ email: string }[]>((res) => {
      resolveOld = res;
    });
    setHostApi({ listMentionableUsers: () => oldFetch } as unknown as Api);
    const { unmount: unmountOld } = render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } }); // starts the OLD (generation N) request
    unmountOld();

    resetMentionRoster(); // navigation — generation bumps to N+1, sharedRosterPromise cleared

    let newCalls = 0;
    let resolveNew!: (u: { email: string }[]) => void;
    const newFetch = new Promise<{ email: string }[]>((res) => {
      resolveNew = res;
    });
    setHostApi({
      listMentionableUsers: () => {
        newCalls++;
        return newFetch; // stays pending, so we can observe whether a later instance re-fetches
      },
    } as unknown as Api);
    const { unmount: unmountNew } = render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @n" } }); // starts the NEW (generation N+1) request — still pending
    expect(newCalls).toBe(1);
    unmountNew();

    // NOW the old, obsolete request finally settles. Its handlers must see the generation mismatch
    // and leave sharedRosterPromise — the newer, still-pending one — untouched.
    resolveOld([{ email: "old-doc-user@example.com" }]);
    await new Promise((r) => setTimeout(r, 0));

    // A THIRD composer instance must reuse the still-pending NEW request, not start another fetch.
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @n" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(newCalls).toBe(1); // no additional listMentionableUsers call

    resolveNew([{ email: "new-doc-user@example.com" }]);
    await screen.findByText("new-doc-user@example.com");
  });

  it("Escape fully closes the dropdown — no stale candidates left showing for the old trigger", async () => {
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await screen.findByText("bob@example.com");
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(document.querySelector(".ap-mention-dropdown")).toBeNull();
  });

  it("moving the caret off the trigger word (no text change) closes the dropdown", async () => {
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } }); // caret lands at the end, inside the trigger word
    await screen.findByText("bob@example.com");
    // Move the caret to the very start — no longer inside/after the "@b" trigger word — WITHOUT
    // changing the text (so onChange never fires; only onSelect can catch this). react-dom's
    // onSelect polyfill listens on mouseup (among other events) to detect selection changes.
    const ta = textarea();
    ta.setSelectionRange(0, 0);
    fireEvent.mouseUp(ta);
    expect(document.querySelector(".ap-mention-dropdown")).toBeNull();
  });

  it("⌘/Ctrl+Enter submits (doesn't pick the highlighted mention) while the dropdown is open", async () => {
    const onSubmit = vi.fn();
    setHostApi({ listMentionableUsers: async () => [{ email: "bob@example.com" }] } as unknown as Api);
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "hey @b" } });
    await screen.findByText("bob@example.com");
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("hey @b", true, []); // submitted as typed, not autocompleted
  });

  it("no @-mention dropdown when the host has no listMentionableUsers (desktop/tests)", () => {
    render(<ComposerPopover {...base} />);
    fireEvent.change(textarea(), { target: { value: "hey @bo" } });
    expect(document.querySelector(".ap-mention-dropdown")).toBeNull();
  });
});
