// SPDX-License-Identifier: AGPL-3.0-or-later

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

// Tag comment-anchor links (`#cmt-...`) so the preview can highlight them and
// wire up click-to-focus behavior. When `showAnchor(id)` is false (e.g. a resolved
// comment while "show resolved" is off), the anchor is rendered as PLAIN TEXT —
// the `<a>` wrapper is dropped on both ends so it reads as ordinary prose, not a link.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
const defaultLinkClose =
  md.renderer.rules.link_close ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));

type LinkEnv = { showAnchor?: (id: string) => boolean; _cmtShow?: boolean[] };

md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const href = tokens[idx]!.attrGet("href") ?? "";
  const m = /^#(cmt-[0-9a-z]+)$/i.exec(href);
  const e = env as LinkEnv;
  let show = true;
  if (m) {
    const id = m[1]!.toLowerCase();
    const pred = e?.showAnchor;
    show = !pred || pred(id);
    if (show) {
      tokens[idx]!.attrSet("data-cmt", id);
      tokens[idx]!.attrSet("class", "ap-anchor");
    }
  }
  // Track shown/hidden per link (links don't nest) so the matching close drops too.
  (e._cmtShow ??= []).push(show);
  if (!show) return ""; // hidden comment anchor → emit no <a>, leaving the label as plain text
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

md.renderer.rules.link_close = (tokens, idx, opts, env, self) => {
  const stack = (env as LinkEnv)._cmtShow;
  const show = stack && stack.length ? stack.pop() : true;
  if (!show) return ""; // matched a suppressed open → drop the closing </a> too
  return defaultLinkClose(tokens, idx, opts, env, self);
};

// Tag block-level elements with their 0-based source line for cross-pane sync.
// `tr_open` is tagged too so clicking a table cell syncs to the clicked ROW's source
// line, not the table's first line (the cells themselves carry no line map).
const BLOCK_RULES = ["paragraph_open", "heading_open", "blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open", "table_open", "tr_open", "hr"];
for (const name of BLOCK_RULES) {
  const orig = md.renderer.rules[name];
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const tok = tokens[idx]!;
    if (tok.map) tok.attrSet("data-line", String(tok.map[0]));
    return orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}
// Fenced/indented code render as full HTML strings; inject data-line on the <pre>.
for (const name of ["fence", "code_block"]) {
  const orig = md.renderer.rules[name];
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const html = orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    const tok = tokens[idx]!;
    return tok.map ? html.replace(/^<pre/, `<pre data-line="${tok.map[0]}"`) : html;
  };
}

// Byte ranges of the input covered by a fenced code block (``` or ~~~), so a `<!-- -->` shown
// as a syntax EXAMPLE inside a fence isn't mistaken for a real author note. Mirrors the
// fence-tracking in core's findBlockOpen (the inplan comment-data-block scanner).
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inFence = false;
  let fenceStart = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceStart = offset;
      } else {
        inFence = false;
        ranges.push([fenceStart, offset + line.length]);
      }
    }
    offset += line.length + 1; // account for the split-out "\n"
  }
  return ranges;
}

// `html: false` (below) makes markdown-it escape raw HTML as visible literal text rather than
// passing it through — a deliberate XSS guard (a collaborative doc's body isn't trusted input,
// and this HTML is fed straight into dangerouslySetInnerHTML). That guard also makes a
// `<!-- author note -->` render as visible text instead of vanishing like a real HTML comment
// would. Strip comments before the guard sees them — narrowly, so nothing else about `html:
// false` changes — but preserve their internal newlines (not the surrounding text) so `data-line`
// stays aligned with the *source* editor for cross-pane sync. Never touch the raw source itself
// (doc.body / SourceEditor) — only this rendered preview.
function stripHtmlComments(body: string): string {
  const fences = fencedRanges(body);
  return body.replace(/<!--[\s\S]*?-->/g, (m, offset: number) => {
    if (fences.some(([s, e]) => offset >= s && offset < e)) return m; // syntax example inside a fence — leave it
    return "\n".repeat((m.match(/\n/g) ?? []).length);
  });
}

/**
 * Render Markdown body to HTML, with comment anchors tagged for the UI and
 * block elements tagged with their source line (`data-line`).
 * `showAnchor(id)` decides whether a comment anchor renders as a highlighted link
 * (true) or as plain text (false, e.g. a resolved comment while "show resolved" is
 * off). When omitted, all anchors render as links.
 */
export function renderMarkdown(body: string, showAnchor?: (id: string) => boolean): string {
  return md.render(stripHtmlComments(body), { showAnchor });
}
