// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Apply the gate's decision to the backend — the one place that decides whether an accepted agent
// edit lands in the file model or the live-collab hub. Split out of cli.ts so it's unit-testable
// without running the CLI's top-level main().

import { type ControlChannel, type DocumentStore, LogEventType } from "@inplan/core/node";
import type { AgentEditEvaluation } from "./gate";
import type { HubGate } from "./peerGate";

/**
 * When `hub` is non-null an entitled live-collab peer is connected and owns the document, so we push
 * the accepted text into the live doc (never touching the `.md`); otherwise we advance the file +
 * persisted canonical (or quarantine a Review-mode body change as a `.proposed.md` for the human to
 * accept). The matching `DocumentEdited` / `AgentRevisionProposed` event is logged either way.
 */
export async function applyGatedEdit(
  store: DocumentStore,
  channel: ControlChannel,
  ev: AgentEditEvaluation,
  ctx: { current: string; canonicalText: string; quarantine: boolean; hub: HubGate | null },
): Promise<void> {
  const { current, canonicalText, quarantine, hub } = ctx;
  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects. On the hub path push the result into
    // the live doc (the hub owns the .md); otherwise write the file + canonical.
    if (hub) await hub.applyRevision(ev.acceptedText);
    else {
      await store.saveDoc(ev.acceptedText);
      await store.setCanonical(ev.acceptedText);
      await store.clearProposed();
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed && quarantine) {
    // Quarantine: park the proposal for the human to accept/reject in the editor. The proposal
    // sidecar is file-based either way; on the file path also revert the working file to canonical
    // (the human's accept later writes canonical). On the hub path the hub owns the working doc, so
    // there's no .md to revert.
    await store.setProposed(current);
    if (!hub) await store.saveDoc(canonicalText);
    await channel.append({ actor: "agent", type: LogEventType.AgentRevisionProposed, payload: { bytes: current.length } });
  } else if (ev.changed) {
    // Auto-accept (auto mode, or review mode with comment-only changes): advance the base. On the
    // hub path that means pushing into the live doc; otherwise advance the persisted canonical.
    if (hub) await hub.applyRevision(current);
    else {
      await store.setCanonical(current);
      await store.clearProposed();
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: current.length } });
  }
}
