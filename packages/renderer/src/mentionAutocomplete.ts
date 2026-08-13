// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Wires an `@`-trigger mention dropdown onto a controlled `<textarea>`. The caller keeps owning
 * `text`/`setText` (as {@link ComposerPopover} and the reply box already do) — this hook only
 * decides when to show suggestions, splices a picked user into the text, and tracks which emails
 * were mentioned. Absent `Api.listMentionableUsers` (desktop, tests) ⇒ `open` never becomes true,
 * so the `@`-trigger is a silent no-op.
 */
export function useMentionAutocomplete(taRef: RefObject<HTMLTextAreaElement>, text: string, setText: (v: string) => void) {
  const [users, setUsers] = useState<MentionCandidate[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const mentionsRef = useRef<Set<string>>(new Set());
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const list = hostApi()?.listMentionableUsers?.();
    if (!list) return;
    list.then((u) => !cancelled && setUsers(u)).catch(() => !cancelled && setUsers([]));
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (!el || !users || !users.length) {
      setOpen(false);
      return;
    }
    const trigger = detectMentionTrigger(el.value, el.selectionStart ?? el.value.length);
    if (!trigger) {
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

  /** Mentioned emails still referenced (`@email`) in `currentText` — filters out entries whose
   *  `@`-marker the author deleted after picking. Call at submit time. */
  const activeMentions = useCallback((currentText: string) => {
    return Array.from(mentionsRef.current).filter((email) => currentText.includes(`@${email}`));
  }, []);

  const reset = useCallback(() => {
    mentionsRef.current.clear();
    setOpen(false);
  }, []);

  return { open, candidates, activeIndex, sync, pick, onKeyDown, activeMentions, reset, setActiveIndex };
}
