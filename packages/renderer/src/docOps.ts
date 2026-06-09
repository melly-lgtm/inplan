// SPDX-License-Identifier: AGPL-3.0-or-later

import { genId, type Comment, type ParsedDocument, type Question } from "@inplan/core";

export function nowIso(): string {
  return new Date().toISOString();
}

function takenIds(doc: ParsedDocument): Set<string> {
  return new Set(doc.comments.map((c) => c.id));
}

/** First occurrence of `text` in the body that is not already an anchor-link label. */
function findPlainOccurrence(body: string, text: string): number {
  if (!text) return -1;
  let from = 0;
  for (;;) {
    const idx = body.indexOf(text, from);
    if (idx === -1) return -1;
    const after = body.slice(idx + text.length, idx + text.length + 3);
    if (after === "](#" || body[idx - 1] === "[") {
      from = idx + 1;
      continue;
    }
    return idx;
  }
}

/**
 * Build a normalized copy of `source` (inline markers * _ ` dropped, whitespace
 * runs collapsed to a single space) plus a map from each kept char's index back
 * to its index in `source`. This lets a preview selection — which has no markup
 * and collapsed whitespace — map back to the exact source range.
 */
function buildNormalized(source: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "*" || ch === "_" || ch === "`" || ch === "~") {
      prevSpace = false;
      continue;
    }
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      text += " ";
      map.push(i);
      prevSpace = true;
    } else {
      text += ch;
      map.push(i);
      prevSpace = false;
    }
  }
  return { text, map };
}

const normalizeNeedle = (s: string): string => s.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();

/** A 0-based, inclusive source line range — the preview block(s) a selection sits in. */
export interface SourceSpan {
  startLine: number;
  endLine: number;
}

/** Find `selected` in `text`: verbatim first, then a markup-/whitespace-insensitive match
 *  (so "showing resolved and orphaned" maps to source "showing resolved *and* orphaned"). */
function searchInText(text: string, selected: string): { start: number; end: number } | null {
  const direct = findPlainOccurrence(text, selected);
  if (direct >= 0) return { start: direct, end: direct + selected.length };
  const needle = normalizeNeedle(selected);
  if (!needle) return null;
  const { text: norm, map } = buildNormalized(text);
  const idx = norm.indexOf(needle);
  if (idx < 0) return null;
  return { start: map[idx]!, end: map[idx + needle.length - 1]! + 1 };
}

/**
 * Locate the source range to anchor for `selected` (the user's preview selection).
 *
 * The selection text alone is ambiguous: the same rendered text can appear in several
 * places, and a verbatim search skips a markup'd occurrence (e.g. "an ma" inside source
 * `` `inplan` makes ``) and wrongly matches a later plain one ("hum**an ma**rks"). When the
 * caller passes the selection's source line span (from the preview block's `data-line`), we
 * search ONLY within those lines and align there — disambiguating to the clicked spot. We
 * fall back to a whole-document search if the span is absent or yields nothing.
 */
export function findSpanRange(body: string, selected: string, span?: SourceSpan): { start: number; end: number } | null {
  // Only honor a sane span: non-negative integer bounds with start <= end. A bogus span
  // (negative or fractional data-line, inverted range) must never index lines[-1] and crash
  // — we ignore it and fall through to the whole-document search below.
  if (span && Number.isInteger(span.startLine) && Number.isInteger(span.endLine) && span.startLine >= 0 && span.endLine >= span.startLine) {
    const lines = body.split("\n");
    let start = 0;
    for (let i = 0; i < span.startLine && i < lines.length; i++) start += lines[i]!.length + 1;
    let end = start;
    for (let i = span.startLine; i <= span.endLine && i < lines.length; i++) end += lines[i]!.length + 1;
    end = Math.min(end, body.length);
    const within = searchInText(body.slice(start, end), selected);
    if (within) return { start: start + within.start, end: start + within.end };
    // not in the hinted lines (stale span / odd selection) → fall through to a global search
  }
  return searchInText(body, selected);
}

// --- inline-markup balancing around an inserted comment link ------------------
//
// Inserting `[label](#id)` can split a paired inline run (bold/italic/strike/code)
// so an opener ends up outside the link and its closer inside (or vice versa), which
// corrupts the rendering. We balance it: pull markers that abut the selection into the
// label, then for any run that still crosses a boundary, close it before the link and
// reopen it after. deleteComment reverses this by merging the split runs back.

/** Paired inline-emphasis markers we balance. Code-span backticks are balanced too,
 *  but as variable-length runs (handled directly in scanOpenMarkers / mergeSeam). */
const PAIRED = ["~~", "**", "__", "*", "_"] as const;

/** The stack of inline-emphasis markers open at `pos`, respecting escapes + code spans.
 *  Markers are LIFO-matched (a marker equal to the stack top closes it, else opens). */
export function scanOpenMarkers(body: string, pos: number): string[] {
  const stack: string[] = [];
  let i = 0;
  while (i < pos) {
    const ch = body[i]!;
    if (ch === "\\") { i += 2; continue; } // escaped char — skip the pair
    if (ch === "`") {
      let n = 0;
      while (body[i + n] === "`") n++;
      const close = body.indexOf("`".repeat(n), i + n);
      if (close !== -1) {
        const codeEnd = close + n;
        if (pos <= codeEnd) {
          // pos is within this code span: emphasis inside is literal (unchanged), but if
          // pos sits in the code *content* (past the opening ticks, at/before the closing
          // ticks) the backtick run is itself an open marker — so a comment boundary there
          // gets balanced like emphasis (close the ticks at the label, reopen after).
          if (pos >= i + n && pos <= close) stack.push("`".repeat(n));
          return stack;
        }
        i = codeEnd;
        continue;
      }
      i += n;
      continue; // unmatched backticks → literal
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let n = 0;
      while (body[i + n] === ch) n++;
      if (ch === "~" && n < 2) { i += n; continue; } // a single ~ isn't strikethrough
      const t = ch === "~" ? "~~" : ch.repeat(n); // run string is the marker (covers *, **, ***, _, __)
      if (stack[stack.length - 1] === t) stack.pop();
      else stack.push(t);
      i += n;
      continue;
    }
    i++;
  }
  return stack;
}

const closeOf = (st: string[]): string => [...st].reverse().join(""); // innermost closes first
const openOf = (st: string[]): string => st.join(""); // outermost opens first

/** Wrap body[start,end) in a comment link, keeping all crossed inline markup balanced. */
export function wrapSpanWithComment(body: string, start: number, end: number, id: string): string {
  // 1. Pull markers that abut the selection into the label (so a fully-contained run like
  //    **Bold** anchors as [**Bold**] rather than emitting an empty `****`).
  for (;;) {
    const m = scanOpenMarkers(body, start).at(-1);
    if (m && body.slice(start - m.length, start) === m) start -= m.length;
    else break;
  }
  for (;;) {
    const m = scanOpenMarkers(body, end).at(-1);
    if (m && body.slice(end, end + m.length) === m) end += m.length;
    else break;
  }
  const openStart = scanOpenMarkers(body, start);
  const openEnd = scanOpenMarkers(body, end);
  // Runs open at BOTH boundaries wrap the whole link (leave them); the rest cross one
  // boundary and must be split: close before the link / reopen inside (start), or close
  // at the label end / reopen after the link (end).
  let c = 0;
  while (c < openStart.length && c < openEnd.length && openStart[c] === openEnd[c]) c++;
  const startCross = openStart.slice(c);
  const endCross = openEnd.slice(c);
  return (
    body.slice(0, start) +
    closeOf(startCross) +
    "[" +
    openOf(startCross) +
    body.slice(start, end) +
    closeOf(endCross) +
    `](#${id})` +
    openOf(endCross) +
    body.slice(end)
  );
}

/** Merge a split inline run at a seam: a closing marker immediately followed by the same
 *  opening marker (left by wrapSpanWithComment) collapses back into one run. */
function mergeSeam(s: string, at: number): string {
  for (const m of [...PAIRED].sort((a, b) => b.length - a.length)) {
    if (s.slice(at - m.length, at) === m && s.slice(at, at + m.length) === m) {
      return s.slice(0, at - m.length) + s.slice(at + m.length);
    }
  }
  // A code-span split leaves "`…`" + "`…`" (an n-backtick close immediately followed by
  // the same-length reopen). Collapse the close+reopen straddling the seam — using the
  // SHORTER of the two adjacent backtick runs, so content backticks next to the delimiter
  // don't inflate the count past the actual close/reopen length (which would defeat the merge).
  let leftN = 0;
  while (s[at - 1 - leftN] === "`") leftN++;
  let rightN = 0;
  while (s[at + rightN] === "`") rightN++;
  const n = Math.min(leftN, rightN);
  if (n > 0) {
    return s.slice(0, at - n) + s.slice(at + n);
  }
  return s;
}

// --- new-doc actions: Create Doc / Move Text to New Doc -----------------------
//
// Both replace the selected span in the body with a Markdown link to the new doc. We reuse the
// span-comment locator (findSpanRange), and only act when the selection doesn't cross an inline-
// emphasis boundary — so the splice can't leave a dangling marker. Crossing selections return
// null and the caller surfaces the same "can't anchor" message as a span comment.

/** Locate `selected` in the body and confirm the open-emphasis stack is identical at both ends
 *  (so any markup inside the selection is self-balanced and safe to replace). null otherwise. */
function locateCleanSpan(body: string, selected: string, span?: SourceSpan): { start: number; end: number } | null {
  const range = findSpanRange(body, selected, span);
  if (!range) return null;
  const a = scanOpenMarkers(body, range.start);
  const b = scanOpenMarkers(body, range.end);
  if (a.length !== b.length || a.some((m, i) => m !== b[i])) return null; // crosses formatting
  return range;
}

/** The source text of the located span (the body Markdown the user selected), or null. Used to
 *  seed the new doc's body for Move Text to New Doc. */
export function spanSource(body: string, selected: string, span?: SourceSpan): string | null {
  const r = locateCleanSpan(body, selected, span);
  return r ? body.slice(r.start, r.end) : null;
}

/** Create Doc: keep the selected text in place but turn it into a link to the new doc. */
export function linkSelectionToDoc(body: string, selected: string, span: SourceSpan | undefined, target: string): string | null {
  const r = locateCleanSpan(body, selected, span);
  if (!r) return null;
  return body.slice(0, r.start) + `[${body.slice(r.start, r.end)}](${target})` + body.slice(r.end);
}

/** Move Text to New Doc: replace the selection with `[title](target)` and carry its span-comment
 *  threads (each anchored root + its replies/answers, resolved ones included) into the new doc, so
 *  they travel with the text instead of being orphaned. Returns:
 *   - `remaining`: the original document after the move (selection → link, moved threads removed),
 *   - `movedBody`: the selected Markdown (the new doc's body),
 *   - `movedComments`: the threads to seed the new doc's comment block.
 *  Returns null when the span can't be located, crosses inline formatting, or a comment anchor
 *  straddles the selection boundary (splitting it would corrupt the link). Doc-level comments
 *  (`anchor:"doc"`, no body link) aren't anchored to the text, so they stay with the original. */
/** The byte range of the WHOLE source lines a block span covers (`startLine`..`endLine`,
 *  inclusive, through the trailing newline). null for a missing/invalid span. Move uses this so a
 *  multi-block selection (e.g. a heading + a blockquote) extracts entire blocks, unlike a comment
 *  anchor which must be a single in-block inline span. */
function spanLineRange(body: string, span?: SourceSpan): { start: number; end: number } | null {
  if (!span || !Number.isInteger(span.startLine) || !Number.isInteger(span.endLine) || span.startLine < 0 || span.endLine < span.startLine) return null;
  const lines = body.split("\n");
  if (span.startLine >= lines.length) return null;
  let start = 0;
  for (let i = 0; i < span.startLine; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = span.startLine; i <= span.endLine && i < lines.length; i++) end += lines[i]!.length + 1;
  return { start, end: Math.min(end, body.length) };
}

export function moveSelectionToDoc(
  doc: ParsedDocument,
  selected: string,
  span: SourceSpan | undefined,
  title: string,
  target: string,
): { remaining: ParsedDocument; movedBody: string; movedComments: Comment[] } | null {
  // Move whole blocks the selection covers (line span) — far less restrictive than a comment
  // anchor; falls back to a verbatim inline match when no usable block span is available.
  const r = spanLineRange(doc.body, span) ?? locateCleanSpan(doc.body, selected, span);
  if (!r) return null;
  // Classify each in-body comment anchor against the span: fully inside (its thread moves), fully
  // outside (stays), or straddling the edge (can't move without splitting the link → abort).
  const rootIds = new Set<string>();
  for (const m of doc.body.matchAll(ANCHOR_RE)) {
    const aStart = m.index;
    const aEnd = aStart + m[0].length;
    const inside = aStart >= r.start && aEnd <= r.end;
    const outside = aEnd <= r.start || aStart >= r.end;
    if (!inside && !outside) return null; // anchor straddles the selection boundary
    if (inside) {
      const id = /#(cmt-[0-9a-z]+)/i.exec(m[0])?.[1];
      if (id) rootIds.add(id);
    }
  }
  // A moved thread = its anchored root + every reply/answer pointing at that root.
  const moved = new Set(rootIds);
  for (const c of doc.comments) if (c.parentId && moved.has(c.parentId)) moved.add(c.id);
  // Keep the moved block's leading markdown (heading #, list marker, blockquote >) on the link that
  // replaces it, so a moved heading stays a heading link / a list item stays a list item ("follow
  // the existing format"). Strip trailing blank lines off the moved content and leave them in the
  // original, so the link keeps its own paragraph break — the line span otherwise swallows the
  // inter-block blank line and the link would fuse onto the next block.
  const fullSlice = doc.body.slice(r.start, r.end);
  const movedBody = fullSlice.replace(/\s+$/, "");
  const before = doc.body.slice(0, r.start);
  const after = doc.body.slice(r.end);
  const prefix = blockPrefix(fullSlice);
  let sep = fullSlice.slice(movedBody.length); // the trailing newline(s) that separated this block
  if (after === "") sep = sep ? "\n" : ""; // at end-of-doc, don't leave a dangling blank line
  const remaining: ParsedDocument = {
    ...doc,
    body: before + prefix + `[${title}](${target})` + sep + after,
    comments: doc.comments.filter((c) => !moved.has(c.id)),
  };
  return { remaining, movedBody, movedComments: doc.comments.filter((c) => moved.has(c.id)) };
}

/** The leading block-level markdown of a slice's first line — heading (`#`), list marker (`-`/`*`/`+`
 *  or `1.`), or blockquote (`>`), including any indent — so the move's placeholder link keeps the
 *  same form as the block it replaced. "" for a plain paragraph or an inline-substring fallback. */
function blockPrefix(slice: string): string {
  const first = slice.split("\n", 1)[0] ?? "";
  return /^(\s*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]+))/.exec(first)?.[1] ?? "";
}

const ANCHOR_RE = /\[[^\]]*\]\(#cmt-[0-9a-z]+\)/gi;

/**
 * Why the current selection can't become a span comment, or null if it can.
 *  - "overlap": the source range intersects an existing comment anchor. Markdown links
 *    can't nest, so wrapping it would corrupt the document.
 *  - "not-found": the rendered selection doesn't map to a contiguous source range
 *    (spans block boundaries / table cells / rendered-only text like decoded entities).
 * An empty selection is anchorable=null here (callers treat it as a doc-level comment).
 */
export function spanCommentBlocker(body: string, selected: string, span?: SourceSpan): "overlap" | "not-found" | null {
  if (!selected.trim()) return null;
  const range = findSpanRange(body, selected, span);
  if (!range) return "not-found";
  for (const m of body.matchAll(ANCHOR_RE)) {
    const aStart = m.index;
    if (range.start < aStart + m[0].length && aStart < range.end) return "overlap";
  }
  return null;
}

export interface NewCommentFields {
  text: string;
  author: string;
  question?: Question;
}

/** Wrap the selected body span in an anchor link and add a span comment. `span` is the
 *  selection's source line range (from the preview block's data-line) — it disambiguates
 *  the anchor location. Null if the span isn't found. */
export function addSpanComment(doc: ParsedDocument, selectedText: string, fields: NewCommentFields, span?: SourceSpan): { doc: ParsedDocument; id: string } | null {
  const range = findSpanRange(doc.body, selectedText, span);
  if (!range) return null;
  const id = genId(takenIds(doc));
  const body = wrapSpanWithComment(doc.body, range.start, range.end, id); // balances crossed inline markup
  const comment: Comment = { id, author: fields.author, date: nowIso(), resolved: false, text: fields.text, ...(fields.question ? { question: fields.question } : {}) };
  return { doc: { body, comments: [...doc.comments, comment] }, id };
}

/** Add a document-level comment. */
export function addDocComment(doc: ParsedDocument, fields: NewCommentFields): { doc: ParsedDocument; id: string } {
  const id = genId(takenIds(doc));
  const comment: Comment = { id, anchor: "doc", author: fields.author, date: nowIso(), resolved: false, text: fields.text, ...(fields.question ? { question: fields.question } : {}) };
  return { doc: { ...doc, comments: [...doc.comments, comment] }, id };
}

/** Add a reply to a comment thread. */
export function addReply(doc: ParsedDocument, parentId: string, text: string, author: string): { doc: ParsedDocument; id: string } {
  const id = genId(takenIds(doc));
  const comment: Comment = { id, parentId, author, date: nowIso(), resolved: false, text };
  return { doc: { ...doc, comments: [...doc.comments, comment] }, id };
}

/** Answer a question comment: a reply carrying the chosen labels (+ optional free text). */
export function addAnswer(doc: ParsedDocument, parentId: string, selected: string[], text: string, author: string): { doc: ParsedDocument; id: string } {
  const id = genId(takenIds(doc));
  const comment: Comment = { id, parentId, author, date: nowIso(), resolved: false, selected, text };
  return { doc: { ...doc, comments: [...doc.comments, comment] }, id };
}

/**
 * Set the human's answer to a question: if an answer already exists in the thread
 * (a child with a `selected` array), update it in place; otherwise add a new one.
 * Prevents a duplicate answer comment when the user changes their selection.
 */
export function setAnswer(doc: ParsedDocument, parentId: string, selected: string[], text: string, author: string): { doc: ParsedDocument; id: string } {
  const existing = doc.comments.find((c) => c.parentId === parentId && Array.isArray(c.selected));
  if (!existing) return addAnswer(doc, parentId, selected, text, author);
  const comments = doc.comments.map((c) => (c.id === existing.id ? { ...c, selected, text, author, date: nowIso() } : c));
  return { doc: { ...doc, comments }, id: existing.id };
}

export function setResolved(doc: ParsedDocument, id: string, resolved: boolean): ParsedDocument {
  return { ...doc, comments: doc.comments.map((c) => (c.id === id ? { ...c, resolved } : c)) };
}

export function editCommentText(doc: ParsedDocument, id: string, text: string): ParsedDocument {
  return { ...doc, comments: doc.comments.map((c) => (c.id === id ? { ...c, text } : c)) };
}

/** Delete a comment (and its descendant replies); strip its anchor link back to plain text,
 *  merging any inline run that wrapSpanWithComment split across the link boundaries. */
export function deleteComment(doc: ParsedDocument, id: string): ParsedDocument {
  const link = new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`);
  const m = link.exec(doc.body);
  let body = doc.body;
  if (m) {
    const label = m[1] ?? "";
    let merged = doc.body.slice(0, m.index) + label + doc.body.slice(m.index + m[0].length);
    // Merge at the end seam first so the start-seam offset stays valid.
    merged = mergeSeam(merged, m.index + label.length);
    merged = mergeSeam(merged, m.index);
    body = merged;
  }
  const removed = new Set<string>([id]);
  // Cascade to descendants.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of doc.comments) {
      if (c.parentId && removed.has(c.parentId) && !removed.has(c.id)) {
        removed.add(c.id);
        changed = true;
      }
    }
  }
  return { body, comments: doc.comments.filter((c) => !removed.has(c.id)) };
}

export interface Thread {
  root: Comment;
  replies: Comment[];
}

/** Group comments into threads: each top-level (span/doc) comment with its descendant replies in date order. */
export function buildThreads(comments: Comment[]): Thread[] {
  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentId) {
      const list = byParent.get(c.parentId) ?? [];
      list.push(c);
      byParent.set(c.parentId, list);
    }
  }
  const collect = (rootId: string): Comment[] => {
    const out: Comment[] = [];
    const stack = [...(byParent.get(rootId) ?? [])];
    while (stack.length) {
      const c = stack.shift()!;
      out.push(c);
      stack.push(...(byParent.get(c.id) ?? []));
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  };
  return comments.filter((c) => c.parentId === undefined).map((root) => ({ root, replies: collect(root.id) }));
}

/** The newest comment in a thread (its last reply in date order, or the root if none). */
export function lastComment(thread: Thread): Comment {
  return thread.replies.length ? thread.replies[thread.replies.length - 1]! : thread.root;
}

/** A thread the agent suggested resolving: its LAST comment carries `may_resolve` (the agent's
 *  latest reply) and it isn't already resolved. A later human reply (a new last comment without
 *  the flag) clears the suggestion. */
export function suggestsResolve(thread: Thread): boolean {
  return !thread.root.resolved && lastComment(thread).may_resolve === true;
}

/** Resolve every thread the agent suggested (for auto-resolve on load / when the setting flips on).
 *  Returns a new document, or null when nothing was suggested (so callers don't re-persist).
 *
 *  `skip` lists thread root ids already auto-resolved this session: they're left untouched so that
 *  undoing an auto-resolution doesn't immediately re-trigger it (which would clear the redo stack). */
export function autoResolveSuggested(doc: ParsedDocument, skip?: ReadonlySet<string>): ParsedDocument | null {
  const ids = new Set(
    buildThreads(doc.comments)
      .filter(suggestsResolve)
      .map((t) => t.root.id)
      .filter((id) => !skip?.has(id)),
  );
  if (ids.size === 0) return null;
  return { ...doc, comments: doc.comments.map((c) => (ids.has(c.id) ? { ...c, resolved: true } : c)) };
}
