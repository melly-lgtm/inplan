// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MentionCandidate } from "./mentionAutocomplete";

/**
 * The `@`-mention suggestion list, anchored under a textarea. MVP positioning: the textarea's
 * bottom-left, not precise caret-pixel tracking (a mirror-div caret tracker is a follow-up, not
 * required for a usable v1).
 */
export function MentionDropdown({
  candidates,
  activeIndex,
  onPick,
  onHover,
}: {
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (c: MentionCandidate) => void;
  onHover: (i: number) => void;
}): JSX.Element | null {
  if (candidates.length === 0) return null;
  return (
    <div className="ap-mention-dropdown" role="listbox">
      {candidates.map((c, i) => (
        <button
          key={c.email}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={`ap-mention-item${i === activeIndex ? " active" : ""}`}
          onMouseEnter={() => onHover(i)}
          // mousedown (not click) fires before the textarea's blur/onClose handling.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
        >
          <span className="ap-mention-email">{c.email}</span>
          {c.name && <span className="ap-mention-name">{c.name}</span>}
        </button>
      ))}
    </div>
  );
}
