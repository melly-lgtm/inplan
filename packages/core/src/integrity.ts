// SPDX-License-Identifier: AGPL-3.0-or-later

import { anchorLinkCounts } from "./anchors";
import { isReply, isSpanComment, type Comment, type ParsedDocument } from "./types";
import { COMMENT_ID_RE } from "./ids";

export type IntegrityCode =
  | "duplicate_id"
  | "malformed_id"
  | "span_missing_link"
  | "span_duplicate_link"
  | "nonspan_has_link"
  | "dangling_link"
  | "missing_parent"
  | "link_targets_nonspan";

export interface IntegrityError {
  code: IntegrityCode;
  message: string;
  commentId?: string;
}

export interface IntegrityResult {
  ok: boolean;
  errors: IntegrityError[];
}

/**
 * Validate a document against the comment grammar:
 *  - ids are unique and well-formed;
 *  - a span comment has exactly one in-body link; replies/doc comments have none;
 *  - referential integrity both ways (links <-> comment objects, parentId -> comment);
 *  - links only target span comments.
 */
export function checkIntegrity(doc: ParsedDocument): IntegrityResult {
  const errors: IntegrityError[] = [];
  const byId = new Map<string, Comment>();
  const linkCounts = anchorLinkCounts(doc.body);

  for (const c of doc.comments) {
    if (!COMMENT_ID_RE.test(c.id)) {
      errors.push({ code: "malformed_id", commentId: c.id, message: `malformed comment id: ${JSON.stringify(c.id)}` });
    }
    if (byId.has(c.id)) {
      errors.push({ code: "duplicate_id", commentId: c.id, message: `duplicate comment id: ${c.id}` });
    } else {
      byId.set(c.id, c);
    }
  }

  for (const c of doc.comments) {
    const count = linkCounts.get(c.id) ?? 0;

    if (isSpanComment(c)) {
      if (count === 0) {
        errors.push({ code: "span_missing_link", commentId: c.id, message: `span comment ${c.id} has no in-body anchor link` });
      } else if (count > 1) {
        errors.push({ code: "span_duplicate_link", commentId: c.id, message: `span comment ${c.id} has ${count} anchor links (expected 1)` });
      }
    } else if (count > 0) {
      const kind = isReply(c) ? "reply" : "document-level comment";
      errors.push({ code: "nonspan_has_link", commentId: c.id, message: `${kind} ${c.id} must not have an in-body anchor link` });
    }

    if (isReply(c) && !byId.has(c.parentId!)) {
      errors.push({ code: "missing_parent", commentId: c.id, message: `comment ${c.id} references missing parent ${c.parentId}` });
    }
  }

  for (const [id] of linkCounts) {
    const target = byId.get(id);
    if (!target) {
      errors.push({ code: "dangling_link", commentId: id, message: `anchor link #${id} has no matching comment` });
    } else if (!isSpanComment(target)) {
      errors.push({ code: "link_targets_nonspan", commentId: id, message: `anchor link #${id} targets a non-span comment` });
    }
  }

  return { ok: errors.length === 0, errors };
}
