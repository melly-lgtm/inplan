// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Construct and append a comment (reply/answer, document-level, or span-anchored) as a pure text
// transform, so `date` is stamped from the CLI's own clock instead of a value the agent has to
// invent by hand when it hand-edits the JSON block (agents have no real clock access, so those
// values were often rounded guesses — inconsistent with, and sometimes later than, real
// timestamps the app stamps for the human's own comments, which corrupts `orderComments`'
// chronological sort).
//
// A span comment additionally rewrites the body: `span` (the exact text to anchor, which must
// appear exactly once so the target is unambiguous) gets wrapped in `[span](#cmt-id)` in place.
// The result is just written to the file — no gate/channel interaction here — because the agent's
// very next `wait` call evaluates and applies whatever is on disk exactly as it would an agent
// hand-edit, so this only needs to produce a correctly-shaped, integrity-clean document.

import { checkIntegrity, genId, parse, serialize, type Choice, type Comment, type ParsedDocument, type Question } from "@inplan/core";

export class AddCommentError extends Error {}

export interface AddCommentInput {
  text: string;
  author: string;
  /** Reply/answer target. Mutually exclusive with `doc`/`span`. */
  parentId?: string;
  /** Document-level root comment (`anchor: "doc"`). Mutually exclusive with `parentId`/`span`. */
  doc?: boolean;
  /** Span comment: the exact body text to anchor — wrapped in place as `[span](#cmt-id)`. Must
   *  appear exactly once in the body (a repeated substring is rejected as ambiguous rather than
   *  guessing which occurrence was meant). Mutually exclusive with `parentId`/`doc`. */
  span?: string;
  /** Untyped because the caller (the CLI) only has `JSON.parse` output — validated below rather
   *  than trusted via a type assertion, so a syntactically-valid but wrong-shaped `--question`
   *  (`{}`, `"foo"`, a `choices` missing `label`) is rejected instead of getting written into the
   *  document as a comment the editor can't render. */
  question?: unknown;
  /** Sets `may_resolve: true` — the documented way to flag a thread as incorporated,
   *  without setting `resolved` (which stays the human's/app's call). */
  mayResolve?: boolean;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
}

function isChoice(v: unknown): v is Choice {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.label === "string" && (c.description === undefined || typeof c.description === "string");
}

/** Runtime shape check for a `--question` payload — `JSON.parse` only guarantees valid JSON, not
 *  a valid {@link Question} (e.g. `{}` or `"foo"` parse fine but aren't one). */
function isQuestion(v: unknown): v is Question {
  if (typeof v !== "object" || v === null) return false;
  const q = v as Record<string, unknown>;
  return typeof q.multiSelect === "boolean" && Array.isArray(q.choices) && q.choices.every(isChoice);
}

/** Wrap `span` in a fresh `[span](#id)` link, in place, in `body`. Throws if `span` doesn't occur
 *  in the body, or occurs more than once (an ambiguous target — this never guesses). Only ever
 *  called with a non-empty `span` — {@link addComment}'s target check treats an empty string the
 *  same as "no --span given" before this is reached. */
function placeSpanLink(body: string, span: string, id: string): string {
  const first = body.indexOf(span);
  if (first === -1) throw new AddCommentError(`comment: --span text not found in the body: ${JSON.stringify(span)}`);
  if (body.indexOf(span, first + span.length) !== -1) {
    throw new AddCommentError(
      `comment: --span text appears more than once in the body, so the target is ambiguous: ${JSON.stringify(span)}. Include more surrounding context to make it unique.`,
    );
  }
  return body.slice(0, first) + `[${span}](#${id})` + body.slice(first + span.length);
}

/** Build the updated document text with the new comment appended. Throws {@link AddCommentError}
 *  on a usage mistake (bad parent, bad/ambiguous `--span` text, a malformed `question`, or a
 *  resulting integrity violation). */
export function addComment(currentText: string, input: AddCommentInput): { text: string; comment: Comment } {
  const targetCount = (input.parentId ? 1 : 0) + (input.doc ? 1 : 0) + (input.span ? 1 : 0);
  if (targetCount > 1) {
    throw new AddCommentError("comment: --parent-id, --doc, and --span are mutually exclusive");
  }
  if (targetCount === 0) {
    throw new AddCommentError(
      'comment: pass --parent-id <id> (reply), --doc (document-level), or --span "<exact body text>" (anchored to that text)',
    );
  }
  if (input.question !== undefined && !isQuestion(input.question)) {
    throw new AddCommentError('comment: --question must be shaped like { "multiSelect": boolean, "choices": [{ "label": string }, ...] }');
  }

  const doc = parse(currentText);
  if (input.parentId && !doc.comments.some((c) => c.id === input.parentId)) {
    throw new AddCommentError(`comment: no such parent id: ${input.parentId}`);
  }

  const id = genId(new Set(doc.comments.map((c) => c.id)));
  const now = input.now ?? (() => new Date());
  const comment: Comment = {
    id,
    ...(input.parentId ? { parentId: input.parentId } : input.doc ? { anchor: "doc" as const } : {}),
    text: input.text,
    author: input.author,
    date: now().toISOString(),
    resolved: false,
    ...(input.question ? { question: input.question } : {}),
    ...(input.mayResolve ? { may_resolve: true } : {}),
  };

  const body = input.span ? placeSpanLink(doc.body, input.span, id) : doc.body;
  const next: ParsedDocument = { body, comments: [...doc.comments, comment], version: doc.version };
  const integrity = checkIntegrity(next);
  if (!integrity.ok) {
    // A well-formed add — reply, doc-level, or span (its id is fresh, and wrapping the located
    // text only adds characters, never removes an existing `](#id)`) — can't introduce corruption
    // on its own. If this ever fires, the document already had a structural problem before this
    // call; it isn't something this comment caused.
    throw new AddCommentError(
      `comment: the document already had a structural problem before this call (this comment didn't cause it): ${integrity.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return { text: serialize(next), comment };
}
