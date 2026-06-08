// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoot, ***REMOVED***, type Api } from "@inplan/renderer";
import "@inplan/renderer/styles.css";
import { ***REMOVED*** } from "***REMOVED***";
import * as Y from ***REMOVED***;

// The preload exposes the IPC host (everything except live objects) plus the local-hub getter.
// We assemble the final `window.api` here so we can attach a collab binding + ***REMOVED*** comment store
// (live objects that can't cross the contextBridge) when the in-process hub is running. When the
// hub is off (the default), `window.api` is just the host — today's file-backed editor.
interface HostBridge {
  __inplanHost: Api;
  __inplanCollabHub?: () => Promise<{ url: string; docName: string } | null>;
}

async function bootstrap(): Promise<void> {
  const w = window as unknown as HostBridge & { api?: Api };
  const host = w.__inplanHost;
  let api: Api = host;

  try {
    const hub = w.__inplanCollabHub ? await w.__inplanCollabHub() : null;
    if (hub) {
      const ydoc = new ***REMOVED***();
      const provider = new ***REMOVED***({ url: hub.url, name: hub.docName, document: ydoc, token: "local" });
      const awareness = provider.awareness;
      if (awareness) {
        awareness.setLocalStateField("inplanPresence", { kind: "human" });
        api = {
          ...host,
          collab: { ytext: ydoc.getText("body"), awareness },
          commentStore: ***REMOVED***(ydoc.getArray("comments")),
        };
        // Tear down the provider/doc when the window unloads (incl. a reload on doc navigation,
        // which re-bootstraps against the new doc's hub) so connections/docs don't leak.
        window.addEventListener("beforeunload", () => {
          try {
            provider.destroy();
            ydoc.destroy();
          } catch {
            /* best-effort */
          }
        });
      }
    }
  } catch (err) {
    // A hub wiring failure must never block the editor — fall back to the file-backed host.
    console.error("[inplan] local hub wiring failed; using file-backed host", err);
  }

  w.api = api;
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
