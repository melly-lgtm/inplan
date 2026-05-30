// SPDX-License-Identifier: AGPL-3.0-or-later

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

// Tag comment-anchor links (`#cmt-...`) so the preview can highlight them and
// wire up click-to-focus behavior.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));

md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const href = tokens[idx]!.attrGet("href") ?? "";
  const m = /^#(cmt-[0-9a-z]+)$/i.exec(href);
  if (m) {
    const id = m[1]!.toLowerCase();
    tokens[idx]!.attrSet("data-cmt", id);
    // Highlight only when the predicate allows (e.g. unresolved, or "show resolved" on).
    const shouldHighlight = (env as { shouldHighlight?: (id: string) => boolean } | undefined)?.shouldHighlight;
    if (!shouldHighlight || shouldHighlight(id)) {
      tokens[idx]!.attrSet("class", "ap-anchor");
    }
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
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

/**
 * Render Markdown body to HTML, with comment anchors tagged for the UI and
 * block elements tagged with their source line (`data-line`).
 * `shouldHighlight(id)` controls the yellow anchor background; when omitted, all
 * anchors are highlighted.
 */
export function renderMarkdown(body: string, shouldHighlight?: (id: string) => boolean): string {
  return md.render(body, { shouldHighlight });
}
