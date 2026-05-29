// SPDX-License-Identifier: AGPL-3.0-or-later

import { contextBridge, ipcRenderer } from "electron";
import type { Acceptance, Api, Cadence, DocPayload, SaveOptions } from "../shared/api";

const api: Api = {
  load: () => ipcRenderer.invoke("doc:load"),
  save: (content: string, options: SaveOptions) => ipcRenderer.invoke("doc:save", content, options),
  logAction: (type: string, payload?: unknown) => ipcRenderer.invoke("doc:log-action", type, payload),
  setMode: (cadence: Cadence, acceptance: Acceptance) => ipcRenderer.invoke("doc:set-mode", cadence, acceptance),
  complete: (content: string) => ipcRenderer.invoke("doc:complete", content),
  onExternalChange: (cb: (payload: DocPayload) => void) => {
    ipcRenderer.on("doc:external-change", (_e, payload: DocPayload) => cb(payload));
  },
  onAgentDone: (cb: () => void) => {
    ipcRenderer.on("agent:done", () => cb());
  },
};

contextBridge.exposeInMainWorld("api", api);
