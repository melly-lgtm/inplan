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
// Bumped by resetMentionRoster(). A request started BEFORE a navigation captures the generation
// it was issued under; if it resolves/rejects AFTER a navigation (the generation has since moved
// on), its handler must not touch the module cache — otherwise a slow, now-obsolete request for
// the doc we LEFT could clobber (or null out the promise for) the NEW doc's already-current or
// still-in-flight roster.
let rosterGeneration = 0;

/** Clear the module-level roster cache. Real hosts call this on doc navigation (App.tsx's
 *  onNavigated) — the cache is per-doc-open, and an in-window nav to a different doc (a
 *  different org's roster) must not keep serving the previous doc's cached mentionable users.
 *  Tests call it between cases for the same reason (it otherwise leaks across `it()` blocks in
 *  the same file). */
export function resetMentionRoster(): void {
  sharedRosterCache = null;
  sharedRosterPromise = null;
  rosterGeneration++;
}

function loadSharedRoster(): Promise<MentionCandidate[]> {
  if (sharedRosterCache) return Promise.resolve(sharedRosterCache);
  if (!sharedRosterPromise) {
    const generation = rosterGeneration;
    const list = hostApi()?.listMentionableUsers?.();
    sharedRosterPromise = list
      ? list.then((u) => {
          if (generation === rosterGeneration) sharedRosterCache = u; // else: a navigation since made this stale — drop it
          return u;
        })
      : Promise.resolve([]);
    // Do NOT cache a failure as "no roster" — a transient network blip would then disable mentions
    // for the rest of the doc session with no retry. Clear the in-flight marker (only if still the
    // current generation — a newer request may already have replaced it) so the next
    // loadSharedRoster() call tries again instead of returning a dead promise forever.
    sharedRosterPromise.catch(() => {
      if (generation === rosterGeneration) sharedRosterPromise = null;
    });
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

  // Tied to `open` (not derived from `query` alone): once `open` flips false (pick, Escape, the
  // trigger word deleted/moved past), `candidates` must ALSO become empty in the same render, or
  // MentionDropdown — which gates purely on `candidates.length` — would keep showing the stale
  // list from the last open trigger.
  const candidates = open && users && users.length ? filterMentionCandidates(users, query) : [];
  // What's ACTUALLY visible: `open` alone can be true with zero matches (e.g. "@zzz" — the roster
  // has users, just none matching the query), which would otherwise report an expanded-but-empty
  // combobox to assistive tech.
  const isOpen = open && candidates.length > 0;

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
        void loadSharedRoster().then(
          (u) => setUsers((prev) => prev ?? u),
          () => {
            // Failed — leave `users` at null (not a terminal []) and drop the guard, so THIS same
            // mounted textarea's next @-trigger retries instead of being stuck forever.
            requestedRosterRef.current = false;
          },
        );
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
   *  key — the caller should skip its own handling. Plain `Enter` picks the highlighted candidate;
   *  a MODIFIED Enter (⌘/Ctrl+Enter, the composer's submit shortcut) is left alone so it still
   *  reaches the caller's own handler instead of being swallowed by the picker. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpen) return false;
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
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        const c = candidates[activeIndex];
        if (c) pick(c);
        return true;
      }
      return false;
    },
    [isOpen, candidates, activeIndex, pick],
  );

  /** Mentioned emails still referenced as a COMPLETE `@email` token in `currentText` — filters out
   *  entries whose `@`-marker the author deleted, or extended into a different address, after
   *  picking (e.g. "@bob@example.com" hand-edited into "@bob@example.comx" no longer counts). Call
   *  at submit time. */
  const activeMentions = useCallback((currentText: string) => {
    // The lookahead accepts end-of-string, whitespace, OR terminal prose punctuation — plain
    // "@bob@x.com" and "@bob@x.com, thanks" / "@bob@x.com." must both still count. (An address
    // that genuinely ends in one of these chars is rarer than a sentence ending in one.)
    return Array.from(mentionsRef.current).filter((email) => new RegExp(`(?:^|\\s)@${escapeRegExp(email)}(?=$|\\s|[.,;:!?)\\]])`).test(currentText));
  }, []);

  const reset = useCallback(() => {
    mentionsRef.current.clear();
    setOpen(false);
  }, []);

  /** Stable DOM id for the dropdown's listbox (`aria-controls` on the textarea, `id` on the
   *  dropdown). Distinct per hook instance (`useId`) so multiple open composers never collide. */
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId]);

  return {
    /** A trigger word is active. Prefer {@link isOpen} for anything UI-visible (aria-expanded,
     *  aria-controls) — `open` can be true with zero matches (e.g. "@zzz"). */
    open,
    /** The dropdown is actually visibly showing candidates. */
    isOpen,
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
    activeDescendantId: isOpen && candidates[activeIndex] ? optionId(activeIndex) : undefined,
  };
}
