// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoot, setHostApi, type Api } from "@inplan/renderer";
import "@inplan/renderer/styles.css";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";

// A runtime plugin's editor binding ships CodeMirror extensions that the host's <SourceEditor>
// installs — but those must be built against the SAME @codemirror/state / @codemirror/view
// instances the host uses, or CodeMirror's instanceof checks reject them ("Unrecognized extension
// value … multiple instances of @codemirror/state"). The signed bundle can't be deduped at the
// host's build time (it's fetched + imported at runtime), so we publish the host's instances on a
// global the bundle's CodeMirror imports resolve to (see collab-client's build shims). Set this
// BEFORE importing the plugin. (renderer/dist externalizes @codemirror/*, so these ARE the very
// instances <SourceEditor> uses.)
(globalThis as unknown as { __inplanCM?: unknown }).__inplanCM = { state: cmState, view: cmView };

// The preload exposes the file-backed editor API on `window.api`. When a runtime plugin is entitled,
// the main process has verified it and exposes its info via `__inplanPlugin`. If present, we import
// the VERIFIED plugin renderer entry (served by main over the privileged `inplan-plugin:` scheme —
// main only serves bytes it signature-verified), activate it with the opaque session, and merge the
// capabilities it returns (binding / comment store / extra modes) onto the host api via `setHostApi`
// (`window.api` is a frozen contextBridge property and can't be reassigned). Any failure falls back
// to the plain file-backed editor.
interface PluginWindow {
  __inplanPlugin?: () => Promise<{ session: string; rendererUrl: string } | null>;
  api?: Api;
}
interface PluginRendererModule {
  activate: (session: string) => { binding?: Api["binding"]; commentStore?: Api["commentStore"]; extraModes?: Api["extraModes"]; sidePanels?: Api["sidePanels"]; dispose: () => void } | null;
}

async function bootstrap(): Promise<void> {
  const w = window as unknown as PluginWindow;
  try {
    const info = w.__inplanPlugin ? await w.__inplanPlugin() : null;
    if (info && w.api) {
      const mod = (await import(/* @vite-ignore */ info.rendererUrl)) as PluginRendererModule;
      const ext = mod.activate(info.session);
      if (ext && w.api) {
        setHostApi({ ...w.api, binding: ext.binding, commentStore: ext.commentStore, extraModes: ext.extraModes, sidePanels: ext.sidePanels });
        window.addEventListener("beforeunload", () => {
          try {
            ext.dispose();
          } catch {
            /* best-effort teardown */
          }
        });
      }
    }
  } catch (err) {
    // A plugin wiring failure must never block the editor — fall back to the file-backed api.
    console.error("[inplan] plugin unavailable; using the file-backed editor", err);
  }

  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <React.StrictMode>
        <AppRoot />
      </React.StrictMode>,
    );
  }
}

void bootstrap();
