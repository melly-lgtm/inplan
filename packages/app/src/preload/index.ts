// SPDX-License-Identifier: AGPL-3.0-or-later

import { contextBridge, ipcRenderer } from "electron";
import type { Acceptance, Api, Cadence, DocPayload, ProfileController, ProfileState, SaveOptions, Settings } from "@inplan/renderer";

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
}

/** Cloud profile controller: caches main's snapshot, rebuilds action closures
 *  (which invoke main by id), and re-fetches when main pushes `profile:changed`. */
function createProfileController(): ProfileController {
  let cached: ProfileState = { user: null, agentLocation: null, actions: [] };
  const subs = new Set<(s: ProfileState) => void>();
  const toState = (snap: ProfileSnapshot): ProfileState => ({
    user: snap.user,
    agentLocation: snap.agentLocation,
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
  };
}

const api: Api = {
  load: () => ipcRenderer.invoke("doc:load"),
  save: (content: string, options: SaveOptions) => ipcRenderer.invoke("doc:save", content, options),
  logAction: (type: string, payload?: unknown) => ipcRenderer.invoke("doc:log-action", type, payload),
  reportState: (dirty: boolean, content: string) => ipcRenderer.invoke("doc:report-state", dirty, content),
  setMode: (cadence: Cadence, acceptance: Acceptance) => ipcRenderer.invoke("doc:set-mode", cadence, acceptance),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings: Settings) => ipcRenderer.invoke("settings:set", settings),
  complete: (content: string) => ipcRenderer.invoke("doc:complete", content),
  onExternalChange: (cb: (payload: DocPayload) => void) => {
    ipcRenderer.on("doc:external-change", (_e, payload: DocPayload) => cb(payload));
  },
  onAgentDone: (cb: () => void) => {
    ipcRenderer.on("agent:done", () => cb());
  },
  onAgentActive: (cb: () => void) => {
    ipcRenderer.on("agent:active", () => cb());
  },
  onReload: (cb: () => void) => {
    ipcRenderer.on("agent:reload", () => cb());
  },
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getProposal: () => ipcRenderer.invoke("proposal:get"),
  clearProposal: () => ipcRenderer.invoke("proposal:clear"),
  onProposal: (cb: (payload: { content: string }) => void) => {
    ipcRenderer.on("doc:proposal", (_e, payload: { content: string }) => cb(payload));
  },
  openDoc: (target: string) => ipcRenderer.invoke("doc:open", target),
  profile: createProfileController(),
};

contextBridge.exposeInMainWorld("api", api);
