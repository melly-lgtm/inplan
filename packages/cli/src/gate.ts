// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  checkIntegrity,
  detectLostComments,
  parse,
  serialize,
  type Comment,
  type IntegrityError,
  type ParsedDocument,
} from "@inplan/core";

export interface AgentEditEvaluation {
  /** True when no *structural* integrity errors remain (orphaned spans are handled by the confirm gate, not here). */
  integrityOk: boolean;
  /** Structural integrity errors (everything except `span_missing_link`). */
  integrityErrors: IntegrityError[];
  /** Span comments newly orphaned by this edit (link removed vs canonical). */
  lost: Comment[];
  /** Comments the caller still needs to acknowledge via --confirmed-comment-deletion before this
   *  edit can be accepted: newly-orphaned roots, plus any reply left dangling because a confirmed
   *  parent was removed out from under it without its own id being confirmed too. */
  unconfirmed: Comment[];
  /** Confirmed-lost comment ids removed from the accepted document. */
  removedIds: string[];
  /** The accepted document text: current with confirmed-lost comment objects removed. */
  acceptedText: string;
  /** True when current differs from the canonical base. */
  changed: boolean;
}

/**
 * Evaluate an agent's edit before accepting it as canonical:
 *  - newly orphaned span comments (anchor link removed) require confirmation;
 *  - on confirmation those comment objects — and any of their replies that are
 *    ALSO explicitly confirmed, transitively — are removed from the document;
 *  - any *structural* corruption (dangling links, duplicate/malformed ids,
 *    a reply with a link, a missing parent) is a hard error.
 *
 * `span_missing_link` is deliberately excluded from the hard-error set because
 * it is the orphaned-comment condition the confirm gate already handles.
 *
 * A reply is never itself "lost" (`detectLostComments` only ever reports span
 * comments — a reply has no anchor link to lose), so confirming just the
 * orphaned parent's id silently left its replies behind with a dangling
 * `parentId`, which then failed as `missing_parent` even when the caller HAD
 * listed those reply ids in `confirmed` — nothing ever cross-referenced them.
 * The fixpoint loop below closes that gap: it starts from confirmed, newly-
 * orphaned roots and pulls in each of their descendants in turn, but only
 * when that descendant's own id is *also* in `confirmed` — an unconfirmed
 * reply is left in place (and surfaces as `missing_parent`) rather than
 * silently deleted, so every removed comment is still one the caller named.
 *
 * A parent that IS confirmed but leaves an unconfirmed reply behind (the reply's own id was never
 * named) would otherwise surface only as a bare `missing_parent` integrity error — correct, but it
 * leaves the caller to reverse-engineer which reply id it's missing. Since the code already knows
 * exactly which comments dangle, they're reported through `unconfirmed` instead (alongside newly-
 * orphaned roots), so `wait`'s `confirm_required` response names the exact ids to add next time.
 *
 * That dangling scan has to look past `current` alone: an edit can delete a reply object outright
 * (not just leave it dangling) in the same breath as orphaning its parent. Scanning only `current`
 * would never see that reply at all — it's simply gone, so nothing flags its removal as needing
 * confirmation, and it's deleted with no acknowledgement. `deletionGraph` unions in `canonical` so
 * an outright-deleted descendant is still found (and still has to be named), current's copy taking
 * precedence for anything that still exists there.
 */
export function evaluateAgentEdit(
  canonicalText: string,
  currentText: string,
  confirmed: ReadonlySet<string>,
): AgentEditEvaluation {
  const current = parse(currentText);
  const canonical = parse(canonicalText);

  const lost = detectLostComments(canonical, current);
  const deletionGraph = new Map([...canonical.comments, ...current.comments].map((c) => [c.id, c]));

  const removedSet = new Set(lost.filter((c) => confirmed.has(c.id)).map((c) => c.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of deletionGraph.values()) {
      if (c.parentId !== undefined && removedSet.has(c.parentId) && confirmed.has(c.id) && !removedSet.has(c.id)) {
        removedSet.add(c.id);
        grew = true;
      }
    }
  }
  const removedIds = [...removedSet];

  const accepted: ParsedDocument = {
    body: current.body,
    comments: current.comments.filter((c) => !removedSet.has(c.id)),
  };

  // A descendant of something being removed that wasn't itself confirmed — whether it's still
  // standing in `current` (would fail as `missing_parent` below) or was deleted outright in this
  // same edit (never reaches `accepted`/integrity at all, so nothing else would catch it).
  const dangling = [...deletionGraph.values()].filter((c) => c.parentId !== undefined && removedSet.has(c.parentId) && !removedSet.has(c.id));
  const danglingIds = new Set(dangling.map((c) => c.id));
  const unconfirmed = [...lost.filter((c) => !confirmed.has(c.id)), ...dangling];

  const integrityErrors = checkIntegrity(accepted).errors.filter(
    (e) => e.code !== "span_missing_link" && !(e.code === "missing_parent" && e.commentId !== undefined && danglingIds.has(e.commentId)),
  );

  return {
    integrityOk: integrityErrors.length === 0,
    integrityErrors,
    lost,
    unconfirmed,
    removedIds,
    acceptedText: serialize(accepted),
    changed: currentText !== canonicalText,
  };
}
