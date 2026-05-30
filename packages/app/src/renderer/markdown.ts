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

/**
 * Render Markdown body to HTML, with comment anchors tagged for the UI.
 * `shouldHighlight(id)` controls the yellow anchor background; when omitted, all
 * anchors are highlighted.
 */
export function renderMarkdown(body: string, shouldHighlight?: (id: string) => boolean): string {
  return md.render(body, { shouldHighlight });
}
