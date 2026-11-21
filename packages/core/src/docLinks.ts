// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writing and reading a Markdown link to another document by its path. A path is a file name, and
// CommonMark gives several characters a meaning in a link destination: a bare space ends it, an
// unbalanced parenthesis closes it early, and "%XX" is read as an escape. Written raw, a path like
// "my doc.md" was not a link at all, and "a%20b.md" opened "a b.md".

/** One path segment percent-decoded, never throwing: a segment that is not valid percent-encoding
 *  is kept as written. */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** One path segment encoded for a link destination: encodeURIComponent, plus the parentheses it
 *  leaves alone (an unbalanced one would close the destination early). */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** A Markdown link `[text](path)` whose destination reads back as exactly `path`. Each segment is
 *  percent-encoded, so a space, "%", "<", ">" or a parenthesis can't end or alter it; slashes and
 *  `.`/`..` segments stay as they are, so an ordinary path like `./plan.md` is written unchanged.
 *  `text` is written as given — pass Markdown, or escape it with {@link escapeLinkText}. */
export function markdownLink(text: string, path: string): string {
  return `[${text}](${path.split("/").map(encodeSegment).join("/")})`;
}

/** Plain text made safe as a link's text: `\`, `[` and `]` escaped so they can't end it early. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** The path a link's destination names, as the renderer hands it over (markdown-it has already
 *  percent-encoded it): each segment decoded once; a segment that isn't valid encoding is kept. */
export function decodeLinkPath(target: string): string {
  return target.split("/").map(decodeSegment).join("/");
}
