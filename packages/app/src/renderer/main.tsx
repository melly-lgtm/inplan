// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoot, type Api } from "@inplan/renderer";
import "@inplan/renderer/styles.css";

// The preload exposes the file-backed editor API on `window.api`. When the user is entitled, the
// main process has loaded + verified the paid live-collab plugin and exposes its connection info
// via `__inplanCollabHub`. If present, we import the VERIFIED browser bundle (served by main over
// the privileged `inplan-collab:` scheme — main only serves bytes it signature-verified), connect
// it to the local hub, and merge the collab binding + comment store + instant mode onto
// `window.api`. Any failure falls back to the file-backed editor (turn-only).
interface CollabWindow {
  __inplanCollabHub?: () => Promise<{ hubUrl: string; desktopUrl: string } | null>;
  api?: Api;
}
interface DesktopCollabModule {
  connectDesktopCollab: (hubUrl: string) => { collab: Api["collab"]; commentStore: Api["commentStore"]; extraModes: Api["extraModes"]; dispose: () => void } | null;
}

async function bootstrap(): Promise<void> {
  const w = window as unknown as CollabWindow;
  try {
    const info = w.__inplanCollabHub ? await w.__inplanCollabHub() : null;
    if (info && w.api) {
      const mod = (await import(/* @vite-ignore */ info.desktopUrl)) as DesktopCollabModule;
      const ext = mod.connectDesktopCollab(info.hubUrl);
      if (ext) {
        w.api = { ...w.api, collab: ext.collab, commentStore: ext.commentStore, extraModes: ext.extraModes };
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
    // A collab wiring failure must never block the editor — fall back to the file-backed api.
    console.error("[inplan] live-collab unavailable; using the file-backed editor", err);
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
