// SPDX-License-Identifier: AGPL-3.0-or-later

import { contextBridge, ipcRenderer } from "electron";
import type { Acceptance, Api, Cadence, DocPayload, I18nController, I18nState, ProfileController, ProfileState, SaveOptions, Settings } from "@inplan/renderer";

/** Action shapes main sends (no functions cross IPC); the preload turns each into
 *  an `onSelect` that invokes the matching main-side action by id. */
interface ActionDescriptor {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
interface ProfileSnapshot {
  user: { name: string; email?: string } | null;
  agentLocation: "local" | "cloud" | null;
  actions: ActionDescriptor[];
  identitySource?: "cloud" | "git" | "manual" | null;
}

/** Cloud profile controller: caches main's snapshot, rebuilds action closures
 *  (which invoke main by id), and re-fetches when main pushes `profile:changed`. */
function createProfileController(): ProfileController {
  let cached: ProfileState = { user: null, agentLocation: null, actions: [] };
  const subs = new Set<(s: ProfileState) => void>();
  const toState = (snap: ProfileSnapshot): ProfileState => ({
    user: snap.user,
    agentLocation: snap.agentLocation,
    ...(snap.identitySource !== undefined ? { identitySource: snap.identitySource } : {}),
    actions: snap.actions.map((d) => ({
      label: d.label,
      ...(d.primary ? { primary: true } : {}),
      ...(d.danger ? { danger: true } : {}),
      ...(d.disabled ? { disabled: true } : {}),
      onSelect: () => void ipcRenderer.invoke("profile:action", d.id),
    })),
  });
  const refresh = async () => {
    const snap = (await ipcRenderer.invoke("profile:get")) as ProfileSnapshot;
    cached = toState(snap);
    for (const cb of subs) cb(cached);
  };
  ipcRenderer.on("profile:changed", () => void refresh());
  void refresh();
  return {
    get: () => cached,
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    setIdentity: (name: string, email?: string) => ipcRenderer.invoke("profile:set", { name, ...(email ? { email } : {}) }) as Promise<void>,
  };
}

/** The localization snapshot main sends (no functions cross IPC). */
interface I18nSnapshot {
  locale: string;
  catalogs: Record<string, Record<string, string>>;
  available: { code: string; label: string }[];
}

/** i18n controller: caches main's snapshot, adds a `setLocale` that calls back into
 *  main, and re-fetches when main pushes `i18n:changed` (a locale switch or a refresh
 *  after the cloud catalogs load). English-only until main reports a paid session. */
function createI18nController(): I18nController {
  const setLocale = (locale: string) => void ipcRenderer.invoke("i18n:set-locale", locale);
  const toState = (snap: I18nSnapshot): I18nState => ({ locale: snap.locale, catalogs: snap.catalogs, available: snap.available, setLocale });
  let cached: I18nState = toState({ locale: "en", catalogs: {}, available: [{ code: "en", label: "English" }] });
  const subs = new Set<(s: I18nState) => void>();
  const refresh = async () => {
    cached = toState((await ipcRenderer.invoke("i18n:get")) as I18nSnapshot);
    for (const cb of subs) cb(cached);
  };
  ipcRenderer.on("i18n:changed", () => void refresh());
  void refresh();
  return {
    get: () => cached,
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}

const api: Api = {
  load: () => ipcRenderer.invoke("doc:load"),
  save: (content: string, options: SaveOptions) => ipcRenderer.invoke("doc:save", content, options),
  logAction: (type: string, payload?: unknown) => ipcRenderer.invoke("doc:log-action", type, payload),
  telemetry: (event: string, props?: Record<string, string | number | boolean | undefined>) =>
    void ipcRenderer.invoke("telemetry", event, props),
  reportState: (dirty: boolean, content: string) => ipcRenderer.invoke("doc:report-state", dirty, content),
  setMode: (cadence: Cadence, acceptance: Acceptance) => ipcRenderer.invoke("doc:set-mode", cadence, acceptance),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings: Settings) => ipcRenderer.invoke("settings:set", settings),
  exit: {
    showBackButton: false, // desktop quits via the OS window controls, not an in-editor Back button
    onRequest: (cb: () => void) => {
      const handler = (): void => cb();
      ipcRenderer.on("app:confirm-quit", handler);
      return () => ipcRenderer.removeListener("app:confirm-quit", handler);
    },
    quit: (content: string, opts: { save: boolean; startBuild: boolean }) => void ipcRenderer.invoke("app:quit", content, opts),
  },
  onExternalChange: (cb: (payload: DocPayload) => void) => {
    const h = (_e: unknown, payload: DocPayload): void => cb(payload);
    ipcRenderer.on("doc:external-change", h);
    return () => ipcRenderer.removeListener("doc:external-change", h);
  },
  onAgentDone: (cb: () => void) => {
    const h = (): void => cb();
    ipcRenderer.on("agent:done", h);
    return () => ipcRenderer.removeListener("agent:done", h);
  },
  onAgentActive: (cb: () => void) => {
    const h = (): void => cb();
    ipcRenderer.on("agent:active", h);
    return () => ipcRenderer.removeListener("agent:active", h);
  },
  onReload: (cb: () => void) => {
    const h = (): void => cb();
    ipcRenderer.on("agent:reload", h);
    return () => ipcRenderer.removeListener("agent:reload", h);
  },
  onAgentMessage: (cb: (msg: { text: string; ts: string }) => void) => {
    ipcRenderer.on("agent:message", (_e, msg: { text: string; ts: string }) => cb(msg));
  },
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getProposal: () => ipcRenderer.invoke("proposal:get"),
  clearProposal: () => ipcRenderer.invoke("proposal:clear"),
  onProposal: (cb: (payload: { content: string }) => void) => {
    const h = (_e: unknown, payload: { content: string }): void => cb(payload);
    ipcRenderer.on("doc:proposal", h);
    return () => ipcRenderer.removeListener("doc:proposal", h);
  },
  openDoc: (target: string) => ipcRenderer.invoke("doc:open", target),
  newDoc: {
    pickPath: (suggestedName: string) => ipcRenderer.invoke("newdoc:pick", suggestedName) as Promise<string | null>,
    create: (path: string, content: string) => ipcRenderer.invoke("newdoc:create", path, content) as Promise<{ linkTarget: string } | null>,
  },
  navigate: (dir: "back" | "forward") => ipcRenderer.invoke("nav:go", dir),
  onNavState: (cb: (s: { canBack: boolean; canForward: boolean }) => void) => {
    const h = (_e: unknown, s: { canBack: boolean; canForward: boolean }): void => cb(s);
    ipcRenderer.on("nav:state", h);
    return () => ipcRenderer.removeListener("nav:state", h);
  },
  onNavigated: (cb: (payload: DocPayload) => void) => {
    const h = (_e: unknown, payload: DocPayload): void => cb(payload);
    ipcRenderer.on("doc:navigated", h);
    return () => ipcRenderer.removeListener("doc:navigated", h);
  },
  profile: createProfileController(),
  i18n: createI18nController(),
  onUpdateAvailable: (cb: (info: { current: string; latest: string }) => void) => {
    const h = (_e: unknown, info: { current: string; latest: string }): void => cb(info);
    ipcRenderer.on("app:update-available", h);
    return () => ipcRenderer.removeListener("app:update-available", h);
  },
  applyUpdate: () => ipcRenderer.invoke("app:apply-update"),
  restartApp: () => ipcRenderer.invoke("app:restart"),
  // First-run tour: durable flag from ~/.inplan (read synchronously so the very first
  // render decides without a flash); `setOnboarded` persists it on finish/skip.
  onboarded: ipcRenderer.sendSync("onboarding:get") as boolean,
  setOnboarded: () => ipcRenderer.invoke("onboarding:set") as Promise<void>,
};

// The renderer assembles the final `window.api` from this IPC host (so it can attach live
// ***REMOVED*** objects — collab binding + comment store — which can't cross the contextBridge). When
// the local hub is off, the renderer just uses the host as-is, preserving today's behavior.
contextBridge.exposeInMainWorld("__inplanHost", api);
// The local ***REMOVED*** hub's connection info ({url, docName} | null) for the renderer to connect to.
contextBridge.exposeInMainWorld("__inplanCollabHub", () => ipcRenderer.invoke("collab:hub") as Promise<{ url: string; docName: string } | null>);
