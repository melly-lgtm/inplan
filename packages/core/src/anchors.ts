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

/** Blank out fenced blocks and inline code spans so example anchors inside code aren't treated as real. */
function stripCode(body: string): string {
  let inFence = false;
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push("");
    } else if (inFence) {
      out.push("");
    } else {
      out.push(line.replace(/`[^`]*`/g, "")); // drop inline `code` spans
    }
  }
  return out.join("\n");
}

/** Every comment id referenced by an in-body anchor link, in document order (may contain duplicates).
 *  Anchors inside fenced blocks or inline code are ignored (they're documentation examples). */
export function extractAnchorIdList(body: string): string[] {
  const ids: string[] = [];
  for (const m of stripCode(body).matchAll(ANCHOR_LINK_RE)) {
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

/** Matches a full anchored span — `[text](#cmt-id)` — capturing the link text + the id.
 *
 *  The link text allows ONE level of nested brackets, because the anchor is written by wrapping a
 *  verbatim span of the body (`[${span}](#${id})`, see the CLI's placeSpanLink) and that span may
 *  itself contain brackets — anchoring a comment to the heading `# Release [v2]` yields
 *  `# [Release [v2]](#cmt-id)`. A plain `[^\]]*` stops at the inner `]` and matches nothing, which
 *  left such an anchor DETECTABLE (ANCHOR_LINK_RE above only needs the `](#cmt-id)` tail) but not
 *  unwrappable — so it counted toward integrity while {@link unwrapAnchors} silently skipped it.
 *  Deeper nesting still falls through unmatched; matching arbitrary depth needs a parser, and one
 *  level covers spans people actually anchor. The alternation can't run past a `]` except through
 *  the bracketed branch, so adjacent anchors still match separately rather than as one span. */
const ANCHORED_SPAN_RE = /\[((?:[^[\]]|\[[^[\]]*\])*)\]\(#(cmt-[0-9a-z]+)\)/gi;

/** Unwrap the anchor links for `ids` — `[text](#cmt-id)` → `text` — leaving every other anchor intact.
 *  Used to hide a removed comment's span from a projection (e.g. {@link docForAgent} excludes a memo's
 *  comment AND unwraps its body anchor so no dangling link remains). Ids match case-insensitively. */
export function unwrapAnchors(body: string, ids: Set<string>): string {
  if (ids.size === 0) return body;
  const lower = new Set([...ids].map((id) => id.toLowerCase())); // normalize the input too — matching is case-insensitive
  return body.replace(ANCHORED_SPAN_RE, (full, text: string, id: string) => (lower.has(id.toLowerCase()) ? text : full));
}

/** Unwrap EVERY comment anchor — `[text](#cmt-id)` → `text` — regardless of id.
 *
 *  For rendering a span of the body as PLAIN TEXT, where the anchor is noise rather than content.
 *  The canonical case is a document title: a title is derived from the `# ` heading, and anchoring
 *  a comment to that heading rewrites it in place to `# [Title](#cmt-id)`. That link is inplan's
 *  own machinery, not something the author typed, so a title taken verbatim would show the raw
 *  Markdown to everyone looking at a document list. Unlike {@link unwrapAnchors}, this needs no id
 *  set — the caller wants text, and every anchor is equally unwanted. */
export function stripAnchors(text: string): string {
  return text.replace(ANCHORED_SPAN_RE, (_full, inner: string) => inner);
}
