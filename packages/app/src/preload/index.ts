// SPDX-License-Identifier: AGPL-3.0-or-later

import { contextBridge, ipcRenderer } from "electron";
import type { Acceptance, Api, Cadence, DocPayload, SaveOptions, Settings } from "@inplan/renderer";

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
};

contextBridge.exposeInMainWorld("api", api);
