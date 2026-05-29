// SPDX-License-Identifier: AGPL-3.0-or-later

import { extractAnchorIds } from "./anchors";
import { isSpanComment, type Comment, type ParsedDocument } from "./types";

/**
 * Span comments in a document whose in-body anchor link is missing — i.e.
 * orphaned comments. (Position-independent: an anchor only counts as present if
 * the `#cmt-<id>` link exists somewhere in the body.)
 */
export function findOrphans(doc: ParsedDocument): Comment[] {
  const links = extractAnchorIds(doc.body);
  return doc.comments.filter((c) => isSpanComment(c) && !links.has(c.id));
}

/**
 * Comments that became orphaned by the change from `prev` to `next` — a span
 * comment still present in `next` whose anchor link disappeared. This is the set
 * the `wait` gate reports for agent edits (and that user edits auto-accept + log).
 *
 * Comments that were already orphaned in `prev` are not re-reported.
 */
export function detectLostComments(prev: ParsedDocument, next: ParsedDocument): Comment[] {
  const previouslyOrphaned = new Set(findOrphans(prev).map((c) => c.id));
  return findOrphans(next).filter((c) => !previouslyOrphaned.has(c.id));
}
