// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { ProfileMenuItem } from "./api";
import { useI18n, translate } from "./i18n";

/** Up to two initials from a display name, for the avatar. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials || "?";
}

/**
 * The shared identity menu — one component, both hosts (it lives here in
 * `@inplan/renderer`; the Electron app and the web edition each mount it and
 * inject their own actions, exactly like the `Api` seam). It shows the signed-in
 * user (or a signed-out affordance) and a dropdown of host-supplied actions. The
 * agent connection/quota indicator + its preference picker live separately in the
 * menu-bar `<AgentIndicator>`. Purely presentational.
 */
export function ProfileMenu({
  user,
  actions,
}: {
  user: { name: string; email?: string } | null;
  actions: ProfileMenuItem[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const i18n = useI18n(); // one subscription; strings via translate(), picker via i18n.available
  const t = (key: string, vars?: Record<string, string | number>) => translate(i18n, key, vars);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // When the menu has nothing to show (it renders null below), make sure it isn't
  // left "open" — otherwise it would pop open on its own if it reappears later.
  useEffect(() => {
    if (!user && actions.length === 0) setOpen(false);
  }, [user, actions.length]);

  // Nothing to show — no identity and no actions (e.g. a local-only/offline desktop
  // session where the cloud is unreachable). Render no profile chrome at all.
  if (!user && actions.length === 0) return null;

  const accountLabel = user ? user.name : t("profile.notSignedIn");
  return (
    <div className="ap-profile" ref={ref}>
      <button
        className="ap-avatar"
        title={user ? `${user.name}${user.email ? ` <${user.email}>` : ""}` : t("profile.notSignedIn")}
        aria-label={`${t("profile.account")} — ${accountLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ap-avatar-initials">{user ? initialsOf(user.name) : "?"}</span>
      </button>
      {open && (
        <div className="ap-profile-menu" role="menu">
          <div className="ap-profile-id">
            <div className="ap-profile-name">{accountLabel}</div>
            {user?.email && <div className="ap-profile-email">{user.email}</div>}
          </div>
          <div className="ap-profile-actions">
            {actions.map((a, i) => (
              <button
                key={`${a.label}-${i}`}
                role="menuitem"
                className={`ap-profile-action${a.primary ? " ap-primary" : ""}${a.danger ? " ap-danger" : ""}`}
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  void a.onSelect();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
          {i18n.available.length > 1 && (
            <label className="ap-profile-lang">
              <span>{t("profile.language")}</span>
              <select
                className="ap-profile-lang-select"
                value={i18n.locale}
                aria-label={t("profile.language")}
                onChange={(e) => void i18n.setLocale(e.target.value)}
              >
                {i18n.available.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
