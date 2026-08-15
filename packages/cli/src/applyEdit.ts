// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Apply the gate's decision to the backend — the one place that decides whether an accepted agent
// edit lands in the file model or a runtime plugin's document. Split out of cli.ts so it's
// unit-testable without running the CLI's top-level main().

import { type ControlChannel, type DocumentStore, LogEventType } from "@inplan/core/node";
import type { AgentEditEvaluation } from "./gate";
import type { PluginGate } from "./pluginGate";
import { utf8Bytes } from "./remoteDocState";

/**
 * When `gate` is non-null an entitled plugin owns the document, so we push the accepted text into
 * the plugin (never touching the `.md`); otherwise we advance the file + persisted canonical (or
 * quarantine a Review-mode body change as a `.proposed.md` for the human to accept). The matching
 * `DocumentEdited` / `AgentRevisionProposed` event is logged either way.
 *
 * Returns whether the edit was PARKED as a proposal (#88) — the caller surfaces that fact
 * (wait output + stderr + the durable proposal record) so an agent auditing "did my edit
 * land?" never mistakes a parked proposal for a sync failure. `parkFailed` reports the
 * inverse hazard: the park never reached the store, so nothing was proposed — the edit is
 * kept in the working copy (deliberately NOT reverted) and no event is appended; the caller
 * degrades the turn instead of crashing with no status.
 */
export async function applyGatedEdit(
  store: DocumentStore,
  channel: ControlChannel,
  ev: AgentEditEvaluation,
  ctx: { current: string; canonicalText: string; quarantine: boolean; gate: PluginGate | null },
): Promise<{ proposed: boolean; parkFailed?: boolean }> {
  const { current, canonicalText, quarantine, gate } = ctx;
  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects. On the plugin path push the result
    // into the plugin's doc (it owns the .md); otherwise write the file + canonical.
    if (gate) await gate.applyRevision(ev.acceptedText);
    else {
      await store.saveDoc(ev.acceptedText);
      await store.setCanonical(ev.acceptedText);
      await store.clearProposed();
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed && quarantine) {
    // Quarantine: park the proposal for the human to accept/reject in the editor. The proposal
    // sidecar is file-based either way; on the file path also revert the working file to canonical
    // (the human's accept later writes canonical). On the plugin path the plugin owns the working
    // doc, so there's no .md to revert.
    try {
      await store.setProposed(current);
    } catch {
      // The push failed, so nothing is proposed anywhere: keep the working copy as the ONLY copy
      // (skipping the revert below — reverting here would destroy the edit silently), log no
      // event, and let the caller report the degradation. The next run re-detects the divergence
      // and retries the park.
      return { proposed: false, parkFailed: true };
    }
    if (!gate) await store.saveDoc(canonicalText);
    await channel.append({ actor: "agent", type: LogEventType.AgentRevisionProposed, payload: { bytes: utf8Bytes(current) } });
    return { proposed: true };
  } else if (ev.changed) {
    // Auto-accept (auto mode, or review mode with comment-only changes): advance the base. On the
    // plugin path that means pushing into the plugin's doc; otherwise advance the persisted canonical.
    if (gate) await gate.applyRevision(current);
    else {
      await store.setCanonical(current);
      await store.clearProposed();
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: utf8Bytes(current) } });
  }
  return { proposed: false };
}
