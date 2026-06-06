// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small on/off toggle switch — the shared control for the profile-menu settings
// and the per-hunk accept/reject in the review diff. It's a visually-hidden native
// checkbox (so it stays keyboard- and screen-reader-accessible: role="switch") with
// a styled track + thumb rendered as siblings.

import type { JSX, ReactNode } from "react";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Optional inline label rendered before the switch. */
  label?: ReactNode;
  disabled?: boolean;
  /** Extra class on the wrapping <label> (e.g. `ap-switch-row` for full-width rows). */
  className?: string;
  /** Falls back to `label` when it's a string. */
  ariaLabel?: string;
}): JSX.Element {
  return (
    <label className={`ap-switch${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}>
      {label != null && <span className="ap-switch-label">{label}</span>}
      <input
        type="checkbox"
        role="switch"
        className="ap-switch-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        aria-checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ap-switch-track" aria-hidden="true">
        <span className="ap-switch-thumb" />
      </span>
    </label>
  );
}
