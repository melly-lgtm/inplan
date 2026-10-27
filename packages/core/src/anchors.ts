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

/** Per-index "this character is inside code" flags, using the same fenced-block and inline-span
 *  rules as {@link stripCode}. Unwrapping needs positions rather than a blanked copy, because it
 *  has to rewrite the ORIGINAL text — but it must agree with detection about what counts as an
 *  anchor, or a `#cmt-` link written as a documentation example would be ignored when counting
 *  anchors and rewritten when unwrapping them. */
function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const fill = (from: number, len: number) => {
    for (let k = 0; k < len; k++) mask[from + k] = true;
  };
  let at = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      fill(at, line.length); // the delimiter line itself is code, as in stripCode
    } else if (inFence) {
      fill(at, line.length);
    } else {
      for (const m of line.matchAll(/`[^`]*`/g)) fill(at + m.index, m[0].length);
    }
    at += line.length + 1; // + the "\n" that split consumed
  }
  return mask;
}

/** The closing half of an anchor — `](#cmt-id)`. The opening `[` is found by scanning back from it
 *  (see {@link findAnchor}) rather than by regex: link text is a VERBATIM span of the body
 *  (`[${span}](#${id})`, see the CLI's placeSpanLink), so it can contain brackets to any depth, and
 *  even a whole other anchor when a comment is placed over an already-anchored span. */
const ANCHOR_TAIL_RE = /\]\(#(cmt-[0-9a-z]+)\)/gi;

interface AnchorSpan {
  /** Index of the opening `[`. */ start: number;
  /** Index just past the closing `)`. */ end: number;
  /** The link text, brackets and any inner anchors intact. */ text: string;
  id: string;
}

/** The first anchor (in closing-bracket order, so innermost-first when nested) whose id `wanted`
 *  accepts. Anchors inside code are skipped, as are tails with no matching `[`. */
function findAnchor(text: string, wanted: (id: string) => boolean): AnchorSpan | null {
  const mask = codeMask(text);
  for (const m of text.matchAll(ANCHOR_TAIL_RE)) {
    const close = m.index; // the `]`
    if (mask[close] || !wanted(m[1]!.toLowerCase())) continue;
    let depth = 0;
    let open = -1;
    for (let k = close - 1; k >= 0; k--) {
      if (mask[k]) continue; // a bracket inside code is literal, not structural
      const ch = text[k];
      if (ch === "]") depth++;
      else if (ch === "[") {
        if (depth === 0) {
          open = k;
          break;
        }
        depth--;
      }
    }
    if (open === -1) continue; // unbalanced — leave it alone rather than guess
    return { start: open, end: close + m[0].length, text: text.slice(open + 1, close), id: m[1]!.toLowerCase() };
  }
  return null;
}

/** Unwrap every anchor `wanted` accepts — `[text](#cmt-id)` → `text`. Repeats to a fixed point, so
 *  an anchor nested inside another's text is unwrapped too; each pass deletes at least the `[` and
 *  the `](#cmt-id)` tail, so the text strictly shrinks and this terminates. */
function unwrapWhere(text: string, wanted: (id: string) => boolean): string {
  let out = text;
  for (;;) {
    const found = findAnchor(out, wanted);
    if (!found) return out;
    out = out.slice(0, found.start) + found.text + out.slice(found.end);
  }
}

/** Unwrap the anchor links for `ids` — `[text](#cmt-id)` → `text` — leaving every other anchor intact.
 *  Used to hide a removed comment's span from a projection (e.g. {@link docForAgent} excludes a memo's
 *  comment AND unwraps its body anchor so no dangling link remains). Ids match case-insensitively. */
export function unwrapAnchors(body: string, ids: Set<string>): string {
  if (ids.size === 0) return body;
  const lower = new Set([...ids].map((id) => id.toLowerCase())); // normalize the input too — matching is case-insensitive
  return unwrapWhere(body, (id) => lower.has(id));
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
  return unwrapWhere(text, () => true);
}
