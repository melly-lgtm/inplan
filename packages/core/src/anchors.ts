// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-body comment anchors are Markdown links whose href is `#cmt-<id>`:
 *
 *     The plan should [use Postgres](#cmt-abfdb1).
 *
 * Anchoring is deterministic set-membership of these ids in the body — it is
 * position-independent, so a cut&paste that moves the link verbatim keeps the
 * comment attached automatically.
 */
const ANCHOR_LINK_RE = /\]\(#(cmt-[0-9a-z]+)\)/gi;

/** Every comment id referenced by an in-body anchor link, in document order (may contain duplicates). */
export function extractAnchorIdList(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(ANCHOR_LINK_RE)) {
    ids.push(m[1]!.toLowerCase());
  }
  return ids;
}

/** The set of distinct comment ids referenced by in-body anchor links. */
export function extractAnchorIds(body: string): Set<string> {
  return new Set(extractAnchorIdList(body));
}

/** Count of anchor links per comment id (to detect duplicates / missing links). */
export function anchorLinkCounts(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of extractAnchorIdList(body)) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
