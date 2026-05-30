// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Comment, ParsedDocument } from "./types";

/** Opening delimiter of the comment data block. */
export const BLOCK_OPEN = "<!--agent-planner";
/** Closing delimiter of the comment data block. */
export const BLOCK_CLOSE = "-->";

/**
 * Parse an agent-planner Markdown document into its body and comments.
 *
 * The data block is a single HTML comment holding a JSON array:
 *
 *     <!--agent-planner
 *     [ { "id": "cmt-...", ... } ]
 *     -->
 *
 * The returned `body` has the block removed and trailing whitespace trimmed.
 * A document with no block parses to an empty `comments` array.
 */
/**
 * Index of the first `BLOCK_OPEN` that is NOT inside a fenced code block, or -1.
 * This lets a plan document its own comment-block format in a fenced example
 * without that example being mistaken for the real data block.
 */
function findBlockOpen(markdown: string): number {
  let inFence = false;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      // The real data block's delimiter is always at the start of a line; this
      // ignores the marker when it appears mid-line in inline code/prose.
      const trimmed = line.trimStart();
      if (trimmed.startsWith(BLOCK_OPEN)) return offset + (line.length - trimmed.length);
    }
    offset += line.length + 1; // account for the split-out "\n"
  }
  return -1;
}

export function parse(markdown: string): ParsedDocument {
  const openIdx = findBlockOpen(markdown);
  if (openIdx === -1) {
    return { body: markdown.replace(/\s+$/, ""), comments: [] };
  }

  const jsonStart = openIdx + BLOCK_OPEN.length;
  const closeIdx = markdown.indexOf(BLOCK_CLOSE, jsonStart);
  if (closeIdx === -1) {
    throw new ParseError("comment data block is not closed with `-->`");
  }

  const jsonText = markdown.slice(jsonStart, closeIdx).trim();
  let comments: Comment[];
  try {
    const parsed = jsonText.length === 0 ? [] : JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new ParseError("comment data block must contain a JSON array");
    }
    comments = parsed as Comment[];
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(`comment data block is not valid JSON: ${(err as Error).message}`);
  }

  const body = markdown.slice(0, openIdx).replace(/\s+$/, "");
  return { body, comments };
}

/**
 * Serialize a document back to Markdown: the trimmed body, a blank line, then
 * the data block. Round-trips with {@link parse}.
 */
export function serialize(doc: ParsedDocument): string {
  const body = doc.body.replace(/\s+$/, "");
  const json = JSON.stringify(doc.comments, null, 2);
  const block = `${BLOCK_OPEN}\n${json}\n${BLOCK_CLOSE}\n`;
  return body.length === 0 ? `\n${block}` : `${body}\n\n${block}`;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
