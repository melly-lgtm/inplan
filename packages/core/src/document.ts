// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Comment, ParsedDocument } from "./types";

/** Opening delimiter of the comment data block. */
export const BLOCK_OPEN = "<!--inplan";
/** Closing delimiter of the comment data block. */
export const BLOCK_CLOSE = "-->";
/**
 * Current data-block schema version, stamped on the marker as `<!--inplan vN`.
 * Bump when the comment format changes incompatibly; a reader can then branch on
 * the parsed `version` to migrate older documents instead of guessing.
 */
export const DOC_FORMAT_VERSION = 1;

/**
 * Parse an inplan Markdown document into its body and comments.
 *
 * The data block is a single HTML comment holding a JSON array:
 *
 *     <!--inplan
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
    return { body: markdown.replace(/\s+$/, ""), comments: [], version: DOC_FORMAT_VERSION };
  }

  const afterOpen = openIdx + BLOCK_OPEN.length;
  const closeIdx = markdown.indexOf(BLOCK_CLOSE, afterOpen);
  if (closeIdx === -1) {
    throw new ParseError("comment data block is not closed with `-->`");
  }

  // The marker may carry a schema version on its first line: `<!--inplan v2`.
  // Strip it (horizontal whitespace only, so we never cross into the JSON line)
  // and default to version 1 for legacy blocks that have no token.
  let inner = markdown.slice(afterOpen, closeIdx);
  let version = DOC_FORMAT_VERSION;
  const versionMatch = /^[^\S\n]*v(\d+)\b/.exec(inner);
  if (versionMatch) {
    version = Number(versionMatch[1]);
    inner = inner.slice(versionMatch[0].length);
  }

  const jsonText = inner.trim();
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
  return { body, comments, version };
}

/**
 * Serialize a document back to Markdown: the trimmed body, a blank line, then
 * the data block. Round-trips with {@link parse}.
 */
export function serialize(doc: ParsedDocument): string {
  const body = doc.body.replace(/\s+$/, "");
  const json = JSON.stringify(doc.comments, null, 2);
  const version = doc.version ?? DOC_FORMAT_VERSION;
  const block = `${BLOCK_OPEN} v${version}\n${json}\n${BLOCK_CLOSE}\n`;
  return body.length === 0 ? `\n${block}` : `${body}\n\n${block}`;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
