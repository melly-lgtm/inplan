// SPDX-License-Identifier: AGPL-3.0-or-later

import MarkdownIt from "markdown-it";
import { resolveDocPath } from "./links";

// `html: true` lets markdown-it's OWN parser recognize raw HTML (as `html_block` /
// `html_inline` tokens) with full awareness of code spans and fences — a backtick span or
// fenced block is consumed by markdown-it's own higher-priority rules before html_inline/
// html_block ever sees those characters, so `<!--`/`-->` shown as a syntax example inside
// code is untouched, with no hand-rolled fence/code-span tracker to keep in sync with
// CommonMark's actual rules (unclosed fences, backtick-vs-tilde + length matching, etc.).
// The renderer overrides below make an `html_block`/`html_inline` token that IS a comment
// render as nothing (hidden from the preview), and anything else render HTML-escaped —
// i.e. exactly the visible-literal-text behavior `html: false` used to give for ALL raw
// HTML — so a stray `<script>`/`<div>` typed into a collaborative doc is still inert; only
// genuine comments are now hidden instead of shown as escaped text.
const md = new MarkdownIt({ html: true, linkify: true });

// CommonMark allows an HTML block (a comment included) to be indented up to 3 spaces —
// markdown-it keeps that leading whitespace in the token's content, so the match must allow it
// too, or an indented `<!-- note -->` falls through to the escaped-text branch below.
const isHtmlComment = (html: string): boolean => /^\s*<!--[\s\S]*-->\s*$/.test(html);
const renderHtmlToken = (tokens: Parameters<MarkdownIt["renderer"]["renderToken"]>[0], idx: number): string => {
  const html = tokens[idx]!.content;
  return isHtmlComment(html) ? "" : md.utils.escapeHtml(html);
};
md.renderer.rules.html_block = (tokens, idx) => renderHtmlToken(tokens, idx);
md.renderer.rules.html_inline = (tokens, idx) => renderHtmlToken(tokens, idx);

// The preview preserves a paragraph's newlines (`white-space: pre-wrap` on `.ap-rendered p`, so a
// hand-aligned block keeps its lines and columns). markdown-it's default hardbreak rule emits
// `<br>\n` — that trailing newline is cosmetic source formatting, invisible under HTML's default
// whitespace collapsing but a SECOND, real line break once newlines are preserved, which would
// turn every markdown hard break into a blank line. Emit the `<br>` alone. hardbreak is the only
// rule that puts a newline INSIDE a paragraph; markdown-it's renderer adds its other newlines
// around block-level tokens only, which the paragraph-scoped style rule doesn't touch.
md.renderer.rules.hardbreak = () => "<br>";

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

// A relative image src (e.g. from a pasted/picked screenshot: "design.plan.assets/image-....png")
// means nothing to the browser on its own — it resolves against the RENDERER's own bundled
// index.html, not the plan document's folder. When we know the doc's absolute path (desktop
// only; web/cloud docs have no filesystem — `docPath` is then absent/not a real path), resolve
// the relative src against it, the same way `resolveDocPath` already resolves doc-to-doc
// links, and rewrite it to a `file://` URL the `<img>` tag can actually load.
type ImageEnv = { docPath?: string };
const defaultImage = md.renderer.rules.image ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const docPath = (env as ImageEnv).docPath;
  const src = tokens[idx]!.attrGet("src") ?? "";
  // Absolute paths / URLs (http:, file:, data:, //host) are left alone — only a bare relative
  // path (what a sibling-file link always is) gets resolved against the doc.
  if (docPath && src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//") && !src.startsWith("/")) {
    const normalizedDocPath = docPath.replace(/\\/g, "/");
    if (/^([a-z]:)?\//i.test(normalizedDocPath)) {
      // markdown-it already percent-encoded `src` (its normalizeLink runs at parse time, before
      // this renderer rule) — decode it back to the literal path first, or the encodeURI below
      // would double-encode it (e.g. a space's "%20" becoming "%2520", which the OS then looks
      // for literally instead of resolving back to a space).
      const decodedSrc = decodeURI(src);
      const abs = resolveDocPath(normalizedDocPath, decodedSrc); // never carries its own leading "/" — add it back
      const withLeadingSlash = `/${abs.replace(/^\/+/, "")}`;
      // encodeURI (not encodeURIComponent) leaves "/" and a Windows drive letter's ":" alone,
      // only escaping characters actually unsafe in a URL (spaces, unicode, ...).
      tokens[idx]!.attrSet("src", `file://${encodeURI(withLeadingSlash)}`);
    }
  }
  return defaultImage(tokens, idx, opts, env, self);
};

// Tag block-level elements with their 0-based source line for cross-pane sync.
// `tr_open` is tagged too so clicking a table cell syncs to the clicked ROW's source
// line, not the table's first line (the cells themselves carry no line map).
// data-end-line (tok.map's exclusive end, minus one) is the block's own LAST source line —
// used to insert content (e.g. a pasted image) after the whole block, not mid-paragraph.
const BLOCK_RULES = ["paragraph_open", "heading_open", "blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open", "table_open", "tr_open", "hr"];
for (const name of BLOCK_RULES) {
  const orig = md.renderer.rules[name];
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const tok = tokens[idx]!;
    if (tok.map) {
      tok.attrSet("data-line", String(tok.map[0]));
      tok.attrSet("data-end-line", String(tok.map[1] - 1));
    }
    return orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}
// A comment anchor written INSIDE a code block. CommonMark treats a fence's (or an indented
// block's) content as LITERAL TEXT, so `[label](#cmt-id)` there is not a link at all: markdown-it
// hands the renderer the raw characters and the default rule escapes them straight into the
// <code>. That left the reader looking at anchor SYNTAX as if it were part of the code, while the
// comment had nothing to point at — no element carrying data-cmt, so the thread was neither
// clickable in the preview nor reachable from the rail. Nothing stops an author from getting
// there, either: the source-side gate (docOps' spanCommentBlocker) matches the selection against
// the body TEXT and is fence-unaware, so commenting on fenced code writes exactly this document.
//
// So recognize the wrapper in the code's own content: drop the syntax, keep the code text, and
// mark the spanned characters. The pattern is deliberately the same one docOps writes and
// unwraps (its ANCHOR_RE), so what the preview recognizes is exactly what the editor produces.
// An inline code SPAN (`code_inline`) is untouched — that remains the way to show anchor syntax
// literally, and a fence still shows `[x](#not-cmt)` and friends verbatim.
const CODE_ANCHOR_RE = /\[([^\]]*)\]\(#(cmt-[0-9a-z]+)\)/gi;
// The same pattern without /g, for a presence check — `.test` on a global regex advances its
// lastIndex between calls. Derived from `.source` so the two can never drift apart.
const HAS_CODE_ANCHOR = new RegExp(CODE_ANCHOR_RE.source, "i");

/**
 * A code block's body as HTML: the author's text escaped, with each comment-anchor wrapper
 * replaced by its label inside a `<span data-cmt class="ap-anchor">` — a <span> and not an <a>
 * because a link inside <code> would inherit link styling and read as prose, and because every
 * consumer (the preview's click handler, the rail's scroll/flash) resolves its target by
 * `[data-cmt]`. When the anchor is hidden (a resolved comment while "show resolved" is off) the
 * label is emitted bare, matching what the link_open rule does for a paragraph anchor.
 *
 * Escaping is not weakened anywhere: EVERY character of the author's content, label included,
 * goes through `escapeHtml`, and the only markup added is the span — whose id is constrained to
 * `[0-9a-z]` by the pattern that produced it, so it needs no quoting of its own.
 */
function codeBodyWithAnchors(content: string, showAnchor?: (id: string) => boolean): string {
  let out = "";
  let last = 0;
  for (const m of content.matchAll(CODE_ANCHOR_RE)) {
    out += md.utils.escapeHtml(content.slice(last, m.index));
    const id = m[2]!.toLowerCase();
    const label = md.utils.escapeHtml(m[1]!);
    out += showAnchor && !showAnchor(id) ? label : `<span data-cmt="${id}" class="ap-anchor">${label}</span>`;
    last = m.index + m[0].length;
  }
  return out + md.utils.escapeHtml(content.slice(last));
}

// Fenced/indented code render as full HTML strings; inject data-line on the <pre>, and render
// any comment anchor the content carries (see CODE_ANCHOR_RE).
for (const name of ["fence", "code_block"]) {
  const orig = md.renderer.rules[name];
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const render = (): string => (orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options));
    const tok = tokens[idx]!;
    let html: string;
    // An ordinary code block — overwhelmingly the common case — goes down the untouched default
    // path, so this stays a branch rather than a rewrite of how code renders.
    if (HAS_CODE_ANCHOR.test(tok.content)) {
      // Ask the DEFAULT rule for this block's shell (`<pre><code class="language-…">`, built
      // from the info string and the token's attrs) by rendering it with no content, then put
      // our own body inside it. Nothing about the wrapper is reimplemented, and nothing but
      // escapeHtml output and our own span reaches the page. markdown-it's fence rule builds
      // those attrs "without modifying original token", so rendering twice can't duplicate them.
      const raw = tok.content;
      tok.content = "";
      const shell = render();
      tok.content = raw;
      const at = shell.lastIndexOf("</code>");
      html = at < 0 ? render() : shell.slice(0, at) + codeBodyWithAnchors(raw, (env as LinkEnv).showAnchor) + shell.slice(at);
    } else {
      html = render();
    }
    return tok.map ? html.replace(/^<pre/, `<pre data-line="${tok.map[0]}"`) : html;
  };
}

/**
 * Render Markdown body to HTML, with comment anchors tagged for the UI and
 * block elements tagged with their source line (`data-line`).
 * `showAnchor(id)` decides whether a comment anchor renders as a highlighted link
 * (true) or as plain text (false, e.g. a resolved comment while "show resolved" is
 * off). When omitted, all anchors render as links.
 * `docPath`, when it's the current doc's real absolute filesystem path (desktop only), lets a
 * relative image src (e.g. a pasted/picked image) resolve to a loadable `file://` URL.
 */
export function renderMarkdown(body: string, showAnchor?: (id: string) => boolean, docPath?: string): string {
  return md.render(body, { showAnchor, docPath });
}
