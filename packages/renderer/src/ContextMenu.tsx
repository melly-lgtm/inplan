// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * A small right-click menu positioned at the cursor. Closes on outside-click or
 * Escape. `onMouseDown` is prevented so clicking an item does NOT collapse the page
 * text selection the items act on (Add comment / Copy / Find text rely on it).
 */
export function ContextMenu({
  pos,
  items,
  onClose,
}: {
  pos: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ap-ctxmenu" role="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <button
          key={`${it.label}-${i}`}
          type="button"
          role="menuitem"
          className="ap-ctxmenu-item"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
