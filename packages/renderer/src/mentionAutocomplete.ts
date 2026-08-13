// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { hostApi } from "./api";

export interface MentionCandidate {
  email: string;
  name?: string;
}

interface Trigger {
  /** Index of the triggering "@" in the textarea's value. */
  start: number;
  /** Text typed after "@", up to the caret. */
  query: string;
}

/** Finds the `@`-trigger word ending at `caret`, or null if the caret isn't inside one. A trigger
 *  must start a word (string-start or after whitespace) so it doesn't fire mid-email
 *  ("dana@example.com" typed as prose) or after a second "@"/whitespace ends the word. */
export function detectMentionTrigger(value: string, caret: number): Trigger | null {
  if (caret < 0 || caret > value.length) return null;
  const upTo = value.slice(0, caret);
  const at = upTo.lastIndexOf("@");
  if (at === -1) return null;
  const query = upTo.slice(at + 1);
  if (/[\s@]/.test(query)) return null;
  const before = upTo[at - 1];
  if (before !== undefined && !/\s/.test(before)) return null;
  return { start: at, query };
}

/** Case-insensitive prefix/substring match on email or display name, capped for a compact dropdown. */
export function filterMentionCandidates(users: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  const matches = q ? users.filter((u) => u.email.toLowerCase().includes(q) || u.name?.toLowerCase().includes(q)) : users;
  return matches.slice(0, 6);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared across every mounted composer/reply box (a doc can have many ThreadCards): the roster
// is per-doc-open, not per-textarea, so all instances fetch it at most ONCE and reuse the same
// result — both to avoid a fetch storm on load and because Api.listMentionableUsers's own contract
// says hosts should cache it. Module-level (not per-hook-instance) is what makes the sharing work.
let sharedRosterCache: MentionCandidate[] | null = null;
let sharedRosterPromise: Promise<MentionCandidate[]> | null = null;

/** Test-only: clear the module-level roster cache, which otherwise leaks between test cases in
 *  the same file (a real session only ever loads one doc, so it never needs clearing at runtime). */
export function __resetMentionRosterForTests(): void {
  sharedRosterCache = null;
  sharedRosterPromise = null;
}

function loadSharedRoster(): Promise<MentionCandidate[]> {
  if (sharedRosterCache) return Promise.resolve(sharedRosterCache);
  if (!sharedRosterPromise) {
    const list = hostApi()?.listMentionableUsers?.();
    sharedRosterPromise = list
      ? list.then(
          (u) => {
            sharedRosterCache = u;
            return u;
          },
          () => {
            sharedRosterCache = [];
            return [];
          },
        )
      : Promise.resolve([]);
  }
  return sharedRosterPromise;
}

/**
 * Wires an `@`-trigger mention dropdown onto a controlled `<textarea>`. The caller keeps owning
 * `text`/`setText` (as {@link ComposerPopover} and the reply box already do) — this hook only
 * decides when to show suggestions, splices a picked user into the text, and tracks which emails
 * were mentioned. Absent `Api.listMentionableUsers` (desktop, tests) ⇒ `open` never becomes true,
 * so the `@`-trigger is a silent no-op.
 *
 * The roster is fetched lazily — only once the author actually types a trigger, not on mount —
 * and shared (see {@link loadSharedRoster}), so mounting many comment threads' hooks at once (a
 * doc with dozens of ThreadCards) doesn't fire a roster request per thread.
 */
export function useMentionAutocomplete(taRef: RefObject<HTMLTextAreaElement>, text: string, setText: (v: string) => void) {
  const [users, setUsers] = useState<MentionCandidate[] | null>(sharedRosterCache);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const mentionsRef = useRef<Set<string>>(new Set());
  const pendingCaretRef = useRef<number | null>(null);
  const requestedRosterRef = useRef(false);
  const listboxId = useId();

  // Restore the caret after a pick spliced new text in (setSelectionRange only takes effect once
  // the textarea's DOM value has actually updated to match the new `text`).
  useEffect(() => {
    if (pendingCaretRef.current == null) return;
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    taRef.current?.setSelectionRange(caret, caret);
  }, [text, taRef]);

  const candidates = users && users.length ? filterMentionCandidates(users, query) : [];

  /** Call after every textarea change (onChange) to re-derive dropdown-open state from the caret. */
  const sync = useCallback(() => {
    const el = taRef.current;
    if (!el) {
      setOpen(false);
      return;
    }
    const trigger = detectMentionTrigger(el.value, el.selectionStart ?? el.value.length);
    if (!trigger) {
      setOpen(false);
      return;
    }
    if (users == null) {
      // First real trigger this textarea has seen — kick off (or join) the shared roster fetch.
      // sync() re-runs (see the effect below) once it resolves, re-checking the still-current
      // trigger. Guarded so a fetch already in flight isn't re-requested on every keystroke.
      setOpen(false);
      if (!requestedRosterRef.current) {
        requestedRosterRef.current = true;
        void loadSharedRoster().then((u) => setUsers((prev) => prev ?? u));
      }
      return;
    }
    if (!users.length) {
      setOpen(false);
      return;
    }
    setQuery(trigger.query);
    setActiveIndex(0);
    setOpen(true);
  }, [users, taRef]);

  // The roster fetch is async; if the author is mid-trigger by the time it resolves, re-derive
  // dropdown state instead of leaving it stuck closed until their next keystroke.
  useEffect(() => {
    if (users) sync();
  }, [users, sync]);

  const pick = useCallback(
    (c: MentionCandidate) => {
      const el = taRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? el.value.length;
      const trigger = detectMentionTrigger(el.value, caret);
      if (!trigger) return;
      const before = el.value.slice(0, trigger.start);
      const after = el.value.slice(caret);
      const inserted = `@${c.email} `;
      mentionsRef.current.add(c.email);
      pendingCaretRef.current = before.length + inserted.length;
      setText(before + inserted + after);
      setOpen(false);
      el.focus();
    },
    [taRef, setText],
  );

  /** Arrow/Enter/Escape/Tab handling while the dropdown is open. Returns true when it consumed the
   *  key — the caller should skip its own handling (e.g. the composer's ⌘/Ctrl+Enter submit). */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || candidates.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % candidates.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const c = candidates[activeIndex];
        if (c) pick(c);
        return true;
      }
      return false;
    },
    [open, candidates, activeIndex, pick],
  );

  /** Mentioned emails still referenced as a COMPLETE `@email` token in `currentText` — filters out
   *  entries whose `@`-marker the author deleted, or extended into a different address, after
   *  picking (e.g. "@bob@example.com" hand-edited into "@bob@example.comx" no longer counts). Call
   *  at submit time. */
  const activeMentions = useCallback((currentText: string) => {
    return Array.from(mentionsRef.current).filter((email) => new RegExp(`(?:^|\\s)@${escapeRegExp(email)}(?=\\s|$)`).test(currentText));
  }, []);

  const reset = useCallback(() => {
    mentionsRef.current.clear();
    setOpen(false);
  }, []);

  /** Stable DOM id for the dropdown's listbox (`aria-controls` on the textarea, `id` on the
   *  dropdown). Distinct per hook instance (`useId`) so multiple open composers never collide. */
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId]);

  return {
    open,
    candidates,
    activeIndex,
    sync,
    pick,
    onKeyDown,
    activeMentions,
    reset,
    setActiveIndex,
    listboxId,
    optionId,
    activeDescendantId: open && candidates[activeIndex] ? optionId(activeIndex) : undefined,
  };
}
