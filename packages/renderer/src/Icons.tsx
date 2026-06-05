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
