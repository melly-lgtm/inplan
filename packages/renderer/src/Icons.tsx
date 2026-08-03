// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small inline line-icon set for the editor chrome. Deliberately dependency-free
// (no icon library): each icon is a 24×24 stroked SVG that inherits `currentColor`,
// so a button tints its icon on hover/active just by setting `color`. Matches the
// existing inline-SVG approach (see the pane selector) and keeps `core`/renderer lean.

import type { ReactNode } from "react";

/** Shared 24×24 frame: no fill, 2px round strokes, decorative (labels live on the button). */
function Glyph({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconBack = (): JSX.Element => (
  <Glyph><polyline points="15 18 9 12 15 6" /></Glyph>
);
export const IconForward = (): JSX.Element => (
  <Glyph><polyline points="9 18 15 12 9 6" /></Glyph>
);
export const IconUp = (): JSX.Element => (
  <Glyph><polyline points="18 15 12 9 6 15" /></Glyph>
);
export const IconDown = (): JSX.Element => (
  <Glyph><polyline points="6 9 12 15 18 9" /></Glyph>
);
export const IconSettings = (): JSX.Element => (
  <Glyph>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Glyph>
);
export const IconZoomOut = (): JSX.Element => (
  <Glyph><line x1="5" y1="12" x2="19" y2="12" /></Glyph>
);
export const IconZoomIn = (): JSX.Element => (
  <Glyph><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Glyph>
);
export const IconFind = (): JSX.Element => (
  <Glyph><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Glyph>
);
/** Speech bubble with a "+" — add a comment. */
export const IconComment = (): JSX.Element => (
  <Glyph>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <line x1="12" y1="7" x2="12" y2="13" />
    <line x1="9" y1="10" x2="15" y2="10" />
  </Glyph>
);
/** A lined note/memo page — the "leave a memo" side of the composer's agent toggle. */
export const IconMemo = (): JSX.Element => (
  <Glyph>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="14 3 14 9 20 9" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </Glyph>
);
export const IconSave = (): JSX.Element => (
  <Glyph>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </Glyph>
);
/** Paper-plane "send" — finish the turn and hand off to the agent. */
export const IconFinishTurn = (): JSX.Element => (
  <Glyph><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></Glyph>
);
export const IconComplete = (): JSX.Element => (
  <Glyph><polyline points="20 6 9 17 4 12" /></Glyph>
);
/** Counter-clockwise arrow — reopen a resolved thread. */
export const IconReopen = (): JSX.Element => (
  <Glyph><polyline points="3 3 3 9 9 9" /><path d="M3.5 13a8 8 0 1 0 2.2-7.4L3 9" /></Glyph>
);
/** An eye resting on a closed box — "peek into" the hidden (resolved + orphaned) comments. */
export const IconRevealArchive = (): JSX.Element => (
  <Glyph>
    {/* eye, above */}
    <path d="M4 7c2.6-3.2 13.4-3.2 16 0c-2.6 3.2-13.4 3.2-16 0Z" />
    <circle cx="12" cy="7" r="1.6" />
    {/* closed box, below — body + lid seam */}
    <rect x="5" y="13" width="14" height="7" rx="1" />
    <line x1="5" y1="16" x2="19" y2="16" />
  </Glyph>
);

export const IconPencil = (): JSX.Element => (
  <Glyph>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Glyph>
);

// Source-pane formatting toolbar (SourceToolbar.tsx) — same stroked-line style as above.
export const IconBold = (): JSX.Element => (
  <Glyph>
    <path d="M6 4h8a4 4 0 0 1 0 8H6z" />
    <path d="M6 12h9a4 4 0 0 1 0 8H6z" />
  </Glyph>
);
export const IconItalic = (): JSX.Element => (
  <Glyph>
    <line x1="19" y1="4" x2="10" y2="4" />
    <line x1="14" y1="20" x2="5" y2="20" />
    <line x1="15" y1="4" x2="9" y2="20" />
  </Glyph>
);
export const IconStrikethrough = (): JSX.Element => (
  <Glyph>
    <path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <path d="M14 12a4 4 0 0 1 0 8H6" />
    <line x1="4" y1="12" x2="20" y2="12" />
  </Glyph>
);
export const IconHorizontalRule = (): JSX.Element => (
  <Glyph><line x1="4" y1="12" x2="20" y2="12" /></Glyph>
);
/** Filled opening-quote glyph — blockquote. Solid (not stroked) reads more clearly as
 *  quotation marks than a stroked outline does at toolbar size. */
export const IconQuote = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">
    <path d="M9 6c-2.5 0-4.5 2-4.5 4.5S6.5 15 9 15c-.3 2.5-2 4-4.5 4v2c3.5 0 6.5-2.5 6.5-6.5V6H9zm10 0c-2.5 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5c-.3 2.5-2 4-4.5 4v2c3.5 0 6.5-2.5 6.5-6.5V6h-2z" />
  </svg>
);
export const IconBulletList = (): JSX.Element => (
  <Glyph>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </Glyph>
);
/** Checkbox with a checkmark — checklist / task list. */
export const IconChecklist = (): JSX.Element => (
  <Glyph>
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </Glyph>
);
export const IconLink = (): JSX.Element => (
  <Glyph>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Glyph>
);
/** "</>" — inline code. */
export const IconInlineCode = (): JSX.Element => (
  <Glyph>
    <polyline points="16 6 22 12 16 18" />
    <polyline points="8 6 2 12 8 18" />
  </Glyph>
);
/** Curly braces — fenced code block (distinct from the inline "</>" above). */
export const IconCodeBlock = (): JSX.Element => (
  <Glyph>
    <path d="M8 3a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" />
    <path d="M16 3a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2" />
  </Glyph>
);
/** Picture frame (mountain + sun) — insert an image. */
export const IconImage = (): JSX.Element => (
  <Glyph>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </Glyph>
);
