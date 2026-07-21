// SPDX-License-Identifier: AGPL-3.0-or-later

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";

const COLLAB_URL = process.env.INPLAN_COLLAB_URL || "wss://inplan-collab.fly.dev";

export interface PresenceHandle {
  /** Tear down the awareness connection (call when the wait ends / the process exits). */
  destroy: () => void;
}

/**
 * Announce this local agent in a cloud doc's awareness room (Yjs presence), so
 * the web shows an "agent · your machine" badge while `wait --remote` is
 * attached. Agent attachment is **derived from live presence, not stored** —
 * disconnecting (the wait exiting) clears it. Best-effort: presence must never
 * break the wait, so any failure here is swallowed and the wait proceeds.
 */
export function announcePresence(docId: string, token: string, model?: string): PresenceHandle {
  try {
    const ydoc = new Y.Doc();
    // Node has no DOM WebSocket; hand the socket the `ws` polyfill.
    const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL, WebSocketPolyfill: WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: docId, document: ydoc, token });
    // CROSS-REPO CONTRACT: this exact shape — {kind:"agent", agentLocation:"local", model?} — is
    // read verbatim by two places in the proprietary `inplan-cloud` repo: the web's
    // computeAgent() in packages/web/src/supabaseApi.ts (drives the connected-agent badge +
    // Finish-turn availability) and the collab server's noteAwareness() in
    // packages/collab/src/agentTrigger.ts (makes the managed cloud agent stand down while a local
    // CLI holds the turn). There is no shared type across the AGPL/cloud boundary, so a field
    // rename on either side breaks the OTHER side silently — this whole call is best-effort and
    // swallows failures by design. If you change this shape, grep both consumers first.
    provider.awareness?.setLocalStateField("inplanPresence", { kind: "agent", agentLocation: "local", ...(model ? { model } : {}) });
    return {
      destroy: () => {
        try {
          provider.destroy();
          socket.destroy();
          ydoc.destroy();
        } catch {
          /* best-effort teardown */
        }
      },
    };
  } catch {
    return { destroy: () => {} };
  }
}
