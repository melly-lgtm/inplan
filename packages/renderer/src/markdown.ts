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
const BLOCK_RULES = ["paragraph_open", "heading_open", "blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open", "table_open", "hr"];
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

/**
 * Render Markdown body to HTML, with comment anchors tagged for the UI and
 * block elements tagged with their source line (`data-line`).
 * `showAnchor(id)` decides whether a comment anchor renders as a highlighted link
 * (true) or as plain text (false, e.g. a resolved comment while "show resolved" is
 * off). When omitted, all anchors render as links.
 */
export function renderMarkdown(body: string, showAnchor?: (id: string) => boolean): string {
  return md.render(body, { showAnchor });
}
