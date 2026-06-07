// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Light inline markup for the agent-messages log — just `**bold**` and `` `code` ``, rendered in
// a toned-down / terminal feel (bold is NOT heavy weight; see .ap-md-strong). Everything else is
// literal text and newlines are preserved by the container's `white-space: pre-wrap`. This is
// deliberately tiny — the messages read like a console log, not a rendered document.

import type { ReactNode } from "react";

const TOKEN = /\*\*([\s\S]+?)\*\*|`([^`]+?)`/g;

/** Split `text` into React nodes, wrapping `**bold**` and `` `code` `` spans; the rest is plain. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  // Fresh lastIndex per call — the regex is module-level (stateful with /g).
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<span className="ap-md-strong" key={key++}>{m[1]}</span>);
    else if (m[2] !== undefined) out.push(<code className="ap-md-code" key={key++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
