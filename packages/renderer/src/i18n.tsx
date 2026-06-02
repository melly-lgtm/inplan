// SPDX-License-Identifier: AGPL-3.0-or-later
//
// i18n seam for the editor. The English catalog below is the source of truth for keys
// and default text; `t(key)` returns the active-locale string, falling back to English,
// then to the key itself. The active locale + any extra catalogs come from the host via
// `window.api.i18n` (the web wires it for everyone; the desktop only for paid users), so
// with no host i18n the editor simply runs in this built-in English.

import { useEffect, useState } from "react";
import type { Catalog, I18nState, I18nController } from "./api";

/** English base catalog — the source of truth for keys + default text. Values may use
 *  `{name}` placeholders. Keep keys stable; translators key off these. */
export const EN: Catalog = {
  // top bar — controls
  "topbar.turn": "Turn",
  "topbar.instant": "Instant",
  "topbar.back": "Back",
  "topbar.forward": "Forward",
  "topbar.settings": "Settings",
  "topbar.zoomOut": "Zoom out",
  "topbar.zoomIn": "Zoom in",
  "topbar.resetZoom": "Reset zoom",
  "topbar.panes": "{n} pane",
  "topbar.panesPlural": "{n} panes",
  "topbar.find": "Find & replace",
  "topbar.addComment": "Add Comment",
  "topbar.addDocComment": "Add Doc Comment",
  "topbar.addCommentTitle": "Add a comment on the selection",
  "topbar.addDocCommentTitle": "Add a document-level comment",
  "topbar.save": "Save",
  "topbar.saveUnsaved": "Save — unsaved changes",
  "topbar.finishTurn": "Finish turn",
  "topbar.finishTurnTitle": "Finish turn — hand off to the agent",
  "topbar.complete": "Complete",
  "topbar.completeQuit": "Complete & quit",
  "topbar.noAgent": "Connect an agent (open this doc with a local or cloud agent) to use this",
  // settings menu
  "settings.title": "Settings",
  "settings.agentChanges": "Agent changes",
  "settings.autoAccept": "Auto-accept",
  "settings.review": "Review",
  "settings.autoResolve": "Agent auto-resolves a thread after incorporating it",
  // profile menu
  "profile.account": "Account menu",
  "profile.notSignedIn": "Not signed in",
  "profile.language": "Language",
  // comment rail
  "rail.comments": "Comments",
  "rail.resolveThread": "Resolve thread",
  "rail.reopenThread": "Reopen thread",
  "rail.reply": "Reply",
};

/** The default state used when no host i18n is wired (the open core, tests). */
const FALLBACK: I18nState = {
  locale: "en",
  catalogs: { en: EN },
  available: [{ code: "en", label: "English" }],
  setLocale: () => {},
};

const controller = (): I18nController | null => (typeof window !== "undefined" ? (window.api?.i18n ?? null) : null);

/** Resolve a key against a state: active locale → English → the key. Interpolates `{vars}`. */
export function translate(state: I18nState, key: string, vars?: Record<string, string | number>): string {
  const raw = state.catalogs[state.locale]?.[key] ?? state.catalogs.en?.[key] ?? EN[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
}

/**
 * Subscribe to the host's i18n controller using the state-push pattern (useState +
 * subscribe), NOT useSyncExternalStore: the controller is proxied across Electron's
 * contextBridge, where get() does not return a referentially-stable snapshot — the same
 * reason `useProfile` avoids useSyncExternalStore. We store whatever get()/subscribe
 * hands us, so an unstable snapshot can't trigger a render loop. Falls back to English.
 */
function useI18nState(): I18nState {
  const [state, setState] = useState<I18nState>(() => {
    const c = controller();
    return c ? c.get() : FALLBACK;
  });
  useEffect(() => {
    const c = controller();
    if (!c) return;
    setState(c.get());
    return c.subscribe(setState);
  }, []);
  return state;
}

/** Hook: the current i18n state. Components derive a translator with
 *  `translate(state, key, vars)` (one subscription per component). */
export function useI18n(): I18nState {
  return useI18nState();
}
