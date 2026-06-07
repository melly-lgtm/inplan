// SPDX-License-Identifier: AGPL-3.0-or-later

/** A selectable option presented inside a question comment. */
export interface Choice {
  label: string;
  description?: string;
}

/** Structured question payload attached to a comment (agent -> human). */
export interface Question {
  /**
   * false = multiple choice (radio, exactly one).
   * true  = multiple selection (checkbox, any number).
   */
  multiSelect: boolean;
  choices: Choice[];
}

/** A single comment / reply / answer, stored in the document's data block. */
export interface Comment {
  /** `cmt-` + 6 base36 chars. */
  id: string;
  /** Present on replies/answers: id of the parent comment. */
  parentId?: string;
  /** "doc" = document-level (no body anchor link). Absent = span comment (exactly one body link). */
  anchor?: "doc";
  /** Comment body / free-text / "Other" note. */
  text: string;
  /** "Name <email>"; the agent uses a model-qualified author, e.g. "Opus 4.8 <claude@inplan.ai>". */
  author: string;
  /** ISO-8601 timestamp. */
  date: string;
  resolved: boolean;
  /** The agent's resolve suggestion: set on a thread it has incorporated. The agent never sets
   *  `resolved` itself — the app/human owns that. When the thread's *last* comment carries this,
   *  the editor resolves it (auto-resolve on) or shows an "Agent suggested to resolve" badge (off). */
  may_resolve?: boolean;
  /** Choice-based question (agent -> human). */
  question?: Question;
  /** Answer replies: the chosen choice labels (length 1 for multiple choice, 0..n for multiple selection). */
  selected?: string[];
}

/** A parsed document: the Markdown body plus the structured comments. */
export interface ParsedDocument {
  /** The Markdown body, with the inplan data block removed. */
  body: string;
  /** Comments parsed from the data block. */
  comments: Comment[];
  /**
   * Data-block schema version (from the `<!--inplan vN` marker). Absent on
   * legacy documents, which `parse` reports as version 1; `serialize` always
   * stamps it so future format changes can be detected and migrated.
   */
  version?: number;
}

/** A reply/answer carries a parentId. */
export function isReply(c: Comment): boolean {
  return c.parentId !== undefined;
}

/** A document-level comment is anchored to the whole document, not a span. */
export function isDocComment(c: Comment): boolean {
  return c.anchor === "doc";
}

/** A span comment is anchored to a body span via exactly one in-body link. */
export function isSpanComment(c: Comment): boolean {
  return !isReply(c) && !isDocComment(c);
}
