// SPDX-License-Identifier: AGPL-3.0-or-later

import { genId, type Comment, type ParsedDocument, type Question } from "@agent-planner/core";

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

/** Build a copy of `source` with inline markdown markers (* _ `) removed, plus a
 *  map from each kept char's index back to its index in `source`. */
function buildNormalized(source: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "*" || ch === "_" || ch === "`") continue;
    text += ch;
    map.push(i);
  }
  return { text, map };
}

/**
 * Locate the source range to anchor for `selected` (the user's preview selection).
 * Tries a verbatim match first; falls back to a markup-insensitive match so a
 * selection like "showing resolved and orphaned" still matches source
 * "showing resolved *and* orphaned". Returns null if not found.
 */
export function findSpanRange(body: string, selected: string): { start: number; end: number } | null {
  const direct = findPlainOccurrence(body, selected);
  if (direct >= 0) return { start: direct, end: direct + selected.length };

  const needle = selected.replace(/[*_`]/g, "");
  if (!needle) return null;
  const { text, map } = buildNormalized(body);
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  return { start: map[idx]!, end: map[idx + needle.length - 1]! + 1 };
}

export interface NewCommentFields {
  text: string;
  author: string;
  question?: Question;
}

/** Wrap the selected body span in an anchor link and add a span comment. Null if the span isn't found. */
export function addSpanComment(doc: ParsedDocument, selectedText: string, fields: NewCommentFields): { doc: ParsedDocument; id: string } | null {
  const range = findSpanRange(doc.body, selectedText);
  if (!range) return null;
  const id = genId(takenIds(doc));
  const sourceSpan = doc.body.slice(range.start, range.end); // keep original markup in the label
  const body = `${doc.body.slice(0, range.start)}[${sourceSpan}](#${id})${doc.body.slice(range.end)}`;
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

export function setResolved(doc: ParsedDocument, id: string, resolved: boolean): ParsedDocument {
  return { ...doc, comments: doc.comments.map((c) => (c.id === id ? { ...c, resolved } : c)) };
}

export function editCommentText(doc: ParsedDocument, id: string, text: string): ParsedDocument {
  return { ...doc, comments: doc.comments.map((c) => (c.id === id ? { ...c, text } : c)) };
}

/** Delete a comment (and its descendant replies); strip its anchor link back to plain text. */
export function deleteComment(doc: ParsedDocument, id: string): ParsedDocument {
  const link = new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`, "g");
  const body = doc.body.replace(link, "$1");
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
