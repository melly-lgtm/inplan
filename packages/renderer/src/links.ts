// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resolve a relative Markdown link against the current document's path, so a link
// like [x](./y.md) targets the right sibling document in BOTH environments: local
// (a sibling file) and web (/docs/<org>/<repo>/<resolved-path>). The host's
// `Api.openDoc(target)` then opens/navigates to the resolved path.

/** True for a relative link to another Markdown doc — not a URL (`scheme:`/`//`) or a bare `#anchor`. */
export function isInternalDocLink(href: string): boolean {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return false;
  return /\.md(\?[^#]*)?(#.*)?$/i.test(href);
}

/**
 * POSIX-join a relative `href` onto the directory of `basePath`, normalizing
 * `.`/`..`. e.g. resolveDocPath("docs/PLAN.md", "./design.md") -> "docs/design.md";
 * resolveDocPath("docs/PLAN.md", "../README.md") -> "README.md".
 */
export function resolveDocPath(basePath: string, href: string): string {
  const cleanHref = href.replace(/[?#].*$/, ""); // the target path only — drop query/anchor
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const out = cleanHref.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const seg of cleanHref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
