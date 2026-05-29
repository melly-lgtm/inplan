// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  checkIntegrity,
  detectLostComments,
  parse,
  serialize,
  type Comment,
  type IntegrityError,
  type ParsedDocument,
} from "@agent-planner/core";

export interface AgentEditEvaluation {
  /** True when no *structural* integrity errors remain (orphaned spans are handled by the confirm gate, not here). */
  integrityOk: boolean;
  /** Structural integrity errors (everything except `span_missing_link`). */
  integrityErrors: IntegrityError[];
  /** Span comments newly orphaned by this edit (link removed vs canonical). */
  lost: Comment[];
  /** Lost comments not yet acknowledged via --confirmed-comment-deletion. */
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
 *  - on confirmation those comment objects are removed from the document;
 *  - any *structural* corruption (dangling links, duplicate/malformed ids,
 *    a reply with a link, a missing parent) is a hard error.
 *
 * `span_missing_link` is deliberately excluded from the hard-error set because
 * it is the orphaned-comment condition the confirm gate already handles.
 */
export function evaluateAgentEdit(
  canonicalText: string,
  currentText: string,
  confirmed: ReadonlySet<string>,
): AgentEditEvaluation {
  const current = parse(currentText);
  const canonical = parse(canonicalText);

  const lost = detectLostComments(canonical, current);
  const unconfirmed = lost.filter((c) => !confirmed.has(c.id));
  const removedIds = lost.filter((c) => confirmed.has(c.id)).map((c) => c.id);
  const removedSet = new Set(removedIds);

  const accepted: ParsedDocument = {
    body: current.body,
    comments: current.comments.filter((c) => !removedSet.has(c.id)),
  };

  const integrityErrors = checkIntegrity(accepted).errors.filter((e) => e.code !== "span_missing_link");

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
