// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { Acceptance, AgentMode, ProfileMenuItem } from "./api";
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

/** Human-readable note for where the identity was resolved from. */
function sourceNote(src: "cloud" | "git" | "manual" | null | undefined): string | null {
  if (src === "cloud") return "from your inplan.ai account";
  if (src === "git") return "from this repo's git config";
  return null; // manual / unset: no note
}

/**
 * The shared avatar menu — one component, both hosts (it lives here in
 * `@inplan/renderer`; the Electron app and the web edition each mount it and
 * inject their own actions/settings, exactly like the `Api` seam). It holds the
 * resolved identity (or a "set up your profile" affordance + Edit form), the
 * editor Settings, host-supplied cloud actions, and the language picker. It is
 * always shown (Settings are always available); the cloud sign-in/out actions are
 * the only thing the host hides when the cloud link is off. Purely presentational.
 */
export function ProfileMenu({
  user,
  actions,
  identitySource,
  onEditProfile,
  acceptance,
  autoResolve,
  agentMode,
  telemetry,
  onAcceptance,
  onAutoResolve,
  onAgentMode,
  onTelemetry,
  onReplayTutorial,
  forceOpen,
}: {
  user: { name: string; email?: string } | null;
  actions: ProfileMenuItem[];
  identitySource?: "cloud" | "git" | "manual" | null;
  onEditProfile?: (name: string, email?: string) => Promise<void> | void;
  acceptance?: Acceptance;
  autoResolve?: boolean;
  agentMode?: AgentMode;
  telemetry?: boolean;
  onAcceptance?: (a: Acceptance) => void;
  onAutoResolve?: (v: boolean) => void;
  onAgentMode?: (m: AgentMode) => void;
  onTelemetry?: (v: boolean) => void;
  onReplayTutorial?: () => void;
  forceOpen?: boolean; // onboarding holds the menu open on the settings step
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const i18n = useI18n(); // one subscription; strings via translate(), picker via i18n.available
  const t = (key: string, vars?: Record<string, string | number>) => translate(i18n, key, vars);
  const isOpen = forceOpen || open; // forceOpen (onboarding) overrides the outside-click close

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!forceOpen && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [forceOpen]);

  // Closing the menu drops any half-finished edit so it reopens clean.
  useEffect(() => {
    if (!isOpen) setEditing(false);
  }, [isOpen]);

  const canEdit = !!onEditProfile;
  const hasSettings = !!onAcceptance && !!onAutoResolve;
  // Truly empty (no identity, no actions, no edit, no settings) — render no chrome.
  // In the real app the host always supplies settings, so the avatar always shows.
  if (!user && actions.length === 0 && !canEdit && !hasSettings) return null;
  const openEditor = () => {
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setEditing(true);
  };
  const save = async () => {
    const n = name.trim();
    if (!n || !onEditProfile) return;
    await onEditProfile(n, email.trim() || undefined);
    setEditing(false);
    setOpen(false);
  };

  const accountLabel = user ? user.name : t("profile.notSignedIn");
  const note = sourceNote(identitySource);
  return (
    <div className="ap-profile" ref={ref}>
      <button
        className="ap-avatar"
        data-onboard="settings"
        title={user ? `${user.name}${user.email ? ` <${user.email}>` : ""}` : t("profile.account")}
        aria-label={`${t("profile.account")} — ${accountLabel}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ap-avatar-initials">{user ? initialsOf(user.name) : "?"}</span>
      </button>
      {isOpen && (
        <div className="ap-profile-menu" role="menu">
          <div className="ap-profile-id">
            <div className="ap-profile-name">{accountLabel}</div>
            {user?.email && <div className="ap-profile-email">{user.email}</div>}
            {note && <div className="ap-profile-source">{note}</div>}
          </div>

          {editing ? (
            <form
              className="ap-profile-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <input className="ap-profile-input" placeholder="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
              <input className="ap-profile-input" placeholder="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <div className="ap-row">
                <button type="submit" className="ap-profile-action ap-primary" disabled={!name.trim()}>
                  Save
                </button>
                <button type="button" className="ap-link" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="ap-profile-actions">
              {canEdit && (
                <button role="menuitem" className="ap-profile-action" onClick={openEditor}>
                  {user ? "Edit profile" : "Set up your profile"}
                </button>
              )}
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
          )}

          {/* Editor settings (folded in from the old ⚙ menu). */}
          {hasSettings && (
            <div className="ap-profile-section">
              {onAgentMode && (
                <div className="ap-settings-row">
                  <span>{t("settings.agentMode")}</span>
                  <div className="ap-seg">
                    <button className={agentMode !== "implementation" ? "active" : ""} onClick={() => onAgentMode("planning")}>
                      {t("settings.modePlanning")}
                    </button>
                    <button className={agentMode === "implementation" ? "active" : ""} onClick={() => onAgentMode("implementation")}>
                      {t("settings.modeBuild")}
                    </button>
                  </div>
                </div>
              )}
              <div className="ap-settings-row">
                <span>{t("settings.agentChanges")}</span>
                <div className="ap-seg">
                  <button className={acceptance === "auto" ? "active" : ""} onClick={() => onAcceptance!("auto")}>
                    {t("settings.autoAccept")}
                  </button>
                  <button className={acceptance === "review" ? "active" : ""} onClick={() => onAcceptance!("review")}>
                    {t("settings.review")}
                  </button>
                </div>
              </div>
              <label className="ap-settings-row">
                <span>{t("settings.autoResolve")}</span>
                <input type="checkbox" checked={!!autoResolve} onChange={(e) => onAutoResolve!(e.target.checked)} />
              </label>
              <div className="ap-settings-hint">{t("settings.autoResolveHint")}</div>
              {onTelemetry && (
                <>
                  <label className="ap-settings-row">
                    <span>{t("settings.telemetry")}</span>
                    <input type="checkbox" checked={!!telemetry} onChange={(e) => onTelemetry(e.target.checked)} />
                  </label>
                  <div className="ap-settings-hint">{t("settings.telemetryHint")}</div>
                </>
              )}
              {onReplayTutorial && (
                <button
                  className="ap-settings-replay"
                  onClick={() => {
                    setOpen(false);
                    onReplayTutorial();
                  }}
                >
                  {t("settings.replayTutorial")}
                </button>
              )}
            </div>
          )}

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
