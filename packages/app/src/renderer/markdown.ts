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
    tokens[idx]!.attrSet("class", "ap-anchor");
    tokens[idx]!.attrSet("data-cmt", m[1]!.toLowerCase());
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

/** Render Markdown body to HTML, with comment anchors tagged for the UI. */
export function renderMarkdown(body: string): string {
  return md.render(body);
}
