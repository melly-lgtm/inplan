// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The comment seam for the unified-***REMOVED*** document architecture. The renderer's comment CRUD
// (list / add / patch / remove / observe) goes through a single CommentStore, decoupling the
// editor's comment code from transport:
//
//   - Memory-backed (createMemoryCommentStore): single-writer local editing, where the .md
//     file is the canonical artifact and comments live in the parsed document.
//   - ***REMOVED***-backed (***REMOVED***): collaborative editing, where comments are a
//     Y.Array of ***REMOVED*** (one per comment) so add/reply/resolve/answer are independent ***REMOVED***
//     ops that never corrupt each other (no JSON-in-text merging).
//
// Both expose the same interface; the host (desktop vs. cloud) picks the implementation.
// `orderComments` imposes the canonical order used when projecting to the serialized .md /
// documents.body, so that round-trip is deterministic regardless of ***REMOVED*** insertion order.

import { type Comment, orderComments } from "@inplan/core";
import * as Y from ***REMOVED***;

export { orderComments };

/** A transport-agnostic store of a document's comments. */
export interface CommentStore {
  /** The current comments, in canonical order. */
  list(): Comment[];
  /** Append a new comment. */
  add(comment: Comment): void;
  /** Merge a partial update into the comment with this id (fields set to `undefined` are removed). */
  patch(id: string, patch: Partial<Comment>): void;
  /** Remove the comment with this id. */
  remove(id: string): void;
  /** Replace the entire set (used to seed/migrate). */
  replaceAll(comments: Comment[]): void;
  /** Subscribe to any change; returns an unsubscribe. */
  observe(cb: () => void): () => void;
}

// Every comment field. Scalars round-trip directly through ***REMOVED***; the structured fields
// (`question`, `selected`) are stored as opaque JSON values, replaced atomically — never
// sub-edited concurrently, so they need no nested ***REMOVED***.
const ALL_KEYS: (keyof Comment)[] = ["id", "parentId", "anchor", "text", "author", "date", "resolved", "may_resolve", "question", "selected"];

/**
 * Apply the delta between two comment lists to a store — add new, patch changed (including
 * field removals), remove gone. Unlike replaceAll this preserves concurrent ***REMOVED*** ops from
 * other peers (it only touches the comments that actually changed), so it's safe to drive a
 * ***REMOVED*** store from the editor's optimistic ParsedDocument state.
 */
export function reconcileComments(store: CommentStore, prev: Comment[], next: Comment[]): void {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const nextById = new Map(next.map((c) => [c.id, c]));
  for (const c of next) {
    const p = prevById.get(c.id);
    if (!p) store.add(c);
    else {
      const patch = diffComment(p, c);
      if (Object.keys(patch).length > 0) store.patch(c.id, patch);
    }
  }
  for (const c of prev) if (!nextById.has(c.id)) store.remove(c.id);
}

/** The fields that differ between two comments, with `undefined` for fields removed in `next`. */
function diffComment(prev: Comment, next: Comment): Partial<Comment> {
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) patch[k] = b[k];
  }
  return patch as Partial<Comment>;
}

// ---- Memory-backed store (single-writer / local file) ----------------------------------

export function createMemoryCommentStore(initial: Comment[] = []): CommentStore {
  let comments: Comment[] = [...initial];
  const subs = new Set<() => void>();
  const notify = (): void => {
    for (const cb of subs) cb();
  };
  return {
    list: () => orderComments(comments),
    add(comment) {
      comments = [...comments, comment];
      notify();
    },
    patch(id, patch) {
      let changed = false;
      comments = comments.map((c) => {
        if (c.id !== id) return c;
        changed = true;
        const next = { ...c } as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        return next as unknown as Comment;
      });
      if (changed) notify();
    },
    remove(id) {
      const before = comments.length;
      comments = comments.filter((c) => c.id !== id);
      if (comments.length !== before) notify();
    },
    replaceAll(next) {
      comments = [...next];
      notify();
    },
    observe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}

// ---- ***REMOVED***-backed store (collaborative) --------------------------------------------------

type YComment = ***REMOVED***<unknown>;

function toYMap(c: Comment): YComment {
  const entries: [string, unknown][] = [];
  const rec = c as unknown as Record<string, unknown>;
  for (const k of ALL_KEYS) {
    const v = rec[k];
    if (v !== undefined) entries.push([k, v]);
  }
  return new ***REMOVED***(entries);
}

function fromYMap(m: YComment): Comment {
  const c: Record<string, unknown> = {};
  for (const k of ALL_KEYS) {
    const v = m.get(k);
    if (v !== undefined) c[k] = v;
  }
  return c as unknown as Comment;
}

function find(arr: Y.Array<YComment>, id: string): { map: YComment; index: number } | null {
  let i = 0;
  for (const m of arr) {
    if (m.get("id") === id) return { map: m, index: i };
    i++;
  }
  return null;
}

/** A CommentStore over a Y.Array of ***REMOVED*** (one per comment) on a shared ***REMOVED***. */
export function ***REMOVED***(yarray: Y.Array<YComment>): CommentStore {
  const doc = yarray.doc;
  const transact = (fn: () => void): void => (doc ? doc.transact(fn) : fn());
  return {
    list: () => orderComments(yarray.toArray().map(fromYMap)),
    add(comment) {
      transact(() => yarray.push([toYMap(comment)]));
    },
    patch(id, patch) {
      const hit = find(yarray, id);
      if (!hit) return;
      // Structured fields (question/selected) are replaced atomically as opaque values.
      transact(() => {
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) hit.map.delete(k);
          else hit.map.set(k, v);
        }
      });
    },
    remove(id) {
      const hit = find(yarray, id);
      if (!hit) return;
      transact(() => yarray.delete(hit.index, 1));
    },
    replaceAll(next) {
      transact(() => {
        if (yarray.length > 0) yarray.delete(0, yarray.length);
        yarray.push(next.map(toYMap));
      });
    },
    observe(cb) {
      const handler = (): void => cb();
      yarray.observeDeep(handler);
      return () => yarray.unobserveDeep(handler);
    },
  };
}
