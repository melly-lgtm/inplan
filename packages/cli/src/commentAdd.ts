// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Construct and append a reply/answer or document-level comment as a pure text transform, so
// `date` is stamped from the CLI's own clock instead of a value the agent has to invent by hand
// when it hand-edits the JSON block (agents have no real clock access, so those values were
// often rounded guesses — inconsistent with, and sometimes later than, real timestamps the app
// stamps for the human's own comments, which corrupts `orderComments`' chronological sort).
//
// Deliberately excludes span comments: placing a new `[text](#cmt-id)` anchor link at the right
// spot in the body is a body edit, which still goes through the normal Edit/Write + `wait` path.
// The result is just appended to the file — no gate/channel interaction here — because the
// agent's very next `wait` call evaluates and applies whatever is on disk exactly as it would an
// agent hand-edit, so this only needs to produce a correctly-shaped, integrity-clean document.

import { checkIntegrity, genId, parse, serialize, type Comment, type ParsedDocument, type Question } from "@inplan/core";

export class AddCommentError extends Error {}

export interface AddCommentInput {
  text: string;
  author: string;
  /** Reply/answer target. Mutually exclusive with `doc`. */
  parentId?: string;
  /** Document-level root comment (`anchor: "doc"`). Mutually exclusive with `parentId`. */
  doc?: boolean;
  question?: Question;
  /** Sets `may_resolve: true` — the documented way to flag a thread as incorporated,
   *  without setting `resolved` (which stays the human's/app's call). */
  mayResolve?: boolean;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
}

/** Build the updated document text with the new comment appended. Throws {@link AddCommentError}
 *  on a usage mistake (bad parent, span-comment attempt, or a resulting integrity violation —
 *  the last one is defensive; the construction below shouldn't be able to trigger it). */
export function addComment(currentText: string, input: AddCommentInput): { text: string; comment: Comment } {
  if (input.parentId && input.doc) {
    throw new AddCommentError("comment: --parent-id and --doc are mutually exclusive");
  }
  if (!input.parentId && !input.doc) {
    throw new AddCommentError(
      "comment: pass --parent-id <id> (reply) or --doc (document-level). Span comments need an in-body " +
        "[text](#cmt-id) link — edit the body directly instead, then `wait`.",
    );
  }

  const doc = parse(currentText);
  if (input.parentId && !doc.comments.some((c) => c.id === input.parentId)) {
    throw new AddCommentError(`comment: no such parent id: ${input.parentId}`);
  }

  const id = genId(new Set(doc.comments.map((c) => c.id)));
  const now = input.now ?? (() => new Date());
  const comment: Comment = {
    id,
    ...(input.parentId ? { parentId: input.parentId } : { anchor: "doc" as const }),
    text: input.text,
    author: input.author,
    date: now().toISOString(),
    resolved: false,
    ...(input.question ? { question: input.question } : {}),
    ...(input.mayResolve ? { may_resolve: true } : {}),
  };

  const next: ParsedDocument = { body: doc.body, comments: [...doc.comments, comment], version: doc.version };
  const integrity = checkIntegrity(next);
  if (!integrity.ok) {
    throw new AddCommentError(`comment: resulting document failed integrity check: ${integrity.errors.map((e) => e.message).join("; ")}`);
  }
  return { text: serialize(next), comment };
}
