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
type PluginExt = { binding?: Api["binding"]; commentStore?: Api["commentStore"]; extraModes?: Api["extraModes"]; sidePanels?: Api["sidePanels"]; dispose: () => void };
interface PluginWindow {
  __inplanPlugin?: () => Promise<{ session: string; rendererUrl: string } | null>;
  // Desktop only: main fires this after an in-window navigation swapped the doc (+ restarted the
  // plugin's per-doc hub) so we can re-bind in place instead of reloading the whole renderer.
  __inplanOnReactivate?: (cb: () => void) => () => void;
  api?: Api;
}
interface PluginRendererModule {
  activate: (session: string) => PluginExt | null;
}

const w = window as unknown as PluginWindow;
let pluginMod: PluginRendererModule | null = null; // imported once; activate() is re-callable per doc
let currentExt: PluginExt | null = null;

/** (Re)activate the runtime plugin against the CURRENT session (the per-doc hub). Imports the
 *  verified renderer entry once, then on each call disposes the previous activation and re-binds —
 *  so a navigation re-points the binding to the new doc's hub without a full renderer reload. */
async function activatePlugin(): Promise<void> {
  try {
    const info = w.__inplanPlugin ? await w.__inplanPlugin() : null;
    if (!info || !w.api) {
      currentExt = null;
      return;
    }
    if (!pluginMod) pluginMod = (await import(/* @vite-ignore */ info.rendererUrl)) as PluginRendererModule;
    try {
      currentExt?.dispose();
    } catch {
      /* best-effort teardown of the previous doc's binding */
    }
    currentExt = pluginMod.activate(info.session);
    if (currentExt) {
      setHostApi({ ...w.api, binding: currentExt.binding, commentStore: currentExt.commentStore, extraModes: currentExt.extraModes, sidePanels: currentExt.sidePanels });
    }
  } catch (err) {
    // A plugin wiring failure must never block the editor — fall back to the file-backed api.
    console.error("[inplan] plugin unavailable; using the file-backed editor", err);
    currentExt = null;
  }
}

/** Wrapper that re-mounts <AppRoot> (via a key bump) when the host signals a navigation re-bind —
 *  the editor binds its CodeMirror at mount, so a fresh mount picks up the re-activated binding +
 *  loads the new doc, all without reloading the page (the binding is the only thing that changes). */
function Shell(): JSX.Element {
  const [epoch, setEpoch] = React.useState(0);
  React.useEffect(() => {
    const off = w.__inplanOnReactivate?.(() => {
      void activatePlugin().then(() => setEpoch((e) => e + 1));
    });
    const onUnload = (): void => {
      try {
        currentExt?.dispose();
      } catch {
        /* best-effort */
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      off?.();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
  return <AppRoot key={epoch} />;
}

async function bootstrap(): Promise<void> {
  await activatePlugin();
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <React.StrictMode>
        <Shell />
      </React.StrictMode>,
    );
  }
}

void bootstrap();
