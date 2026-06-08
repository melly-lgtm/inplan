// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The comment seam: the renderer's comment CRUD (list / add / patch / remove / observe) goes
// through a single CommentStore, decoupling the editor's comment code from transport. Open-core
// ships the memory-backed store (createMemoryCommentStore): single-writer local editing, where
// the .md file is the canonical artifact and comments live in the parsed document. A collaborative
// (***REMOVED***) store can be injected by a host that provides one (the cloud edition). `orderComments`
// imposes the canonical order used when projecting to the serialized .md, so round-trip is
// deterministic regardless of insertion order.

import { type Comment, orderComments } from "@inplan/core";

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

// The ***REMOVED*** store round-trips EVERY field a comment carries — known schema fields plus any
// unknown/forward-compat ones — so it preserves exactly what @inplan/core's serializeCanonical
// preserves. Scalars round-trip directly; structured fields (question/selected and any nested
// values) are stored as opaque JSON, replaced atomically — never sub-edited concurrently.

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

/** Comment fields a patch must never remove (a comment without them isn't a valid Comment). */
const REQUIRED_KEYS = new Set(["text", "author", "date", "resolved"]);

/** Guard a patch: `id` is immutable (rewriting it would orphan later lookups by id), and the
 *  required fields can't be deleted. Throws on misuse — these never occur in normal reconcile
 *  flow (the diff never includes an unchanged id, and never drops a required field), so this
 *  only catches programmer error. */
function assertValidPatch(patch: Partial<Comment>): void {
  const rec = patch as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, "id")) throw new Error("CommentStore.patch: id is immutable");
  for (const k of REQUIRED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rec, k) && rec[k] === undefined) {
      throw new Error(`CommentStore.patch: cannot remove required field "${k}"`);
    }
  }
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
      assertValidPatch(patch);
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

