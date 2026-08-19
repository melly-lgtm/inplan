// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Apply the gate's decision to the backend — the one place that decides whether an accepted agent
// edit lands in the file model or a runtime plugin's document. Split out of cli.ts so it's
// unit-testable without running the CLI's top-level main().

import { type ControlChannel, type DocumentStore, LogEventType, hashBody, parse } from "@inplan/core/node";
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
): Promise<{ proposed: boolean; proposalId?: string; parkFailed?: boolean; eventLogged?: boolean }> {
  const { current, canonicalText, quarantine, gate } = ctx;
  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects. On the plugin path push the result
    // into the plugin's doc (it owns the .md); otherwise write the file + canonical.
    if (gate) await gate.applyRevision(ev.acceptedText);
    else {
      await store.saveDoc(ev.acceptedText);
      await store.setCanonical(ev.acceptedText);
      await withdrawOwnPending(store);
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed && quarantine) {
    // Quarantine: park the proposal for the human to accept/reject in the editor. The proposal
    // sidecar is file-based either way; on the file path also revert the working file to canonical
    // (the human's accept later writes canonical) — unless the revert would wipe real content
    // with a blank canonical, the #95 clobber (see revertWouldWipe). On the plugin path the
    // plugin owns the working doc, so there's no .md to revert.
    let proposalId: string;
    try {
      ({ id: proposalId } = await store.createProposal({ content: current, baseHash: hashBody(canonicalText), baseContent: canonicalText }));
    } catch {
      // The push failed, so nothing is proposed anywhere: keep the working copy as the ONLY copy
      // (skipping the revert below — reverting would destroy the edit silently), log no event,
      // and let the caller report the degradation. The next run re-detects the divergence and
      // retries the park idempotently.
      //
      // CONTRACT for composite stores: a `createProposal` rejection must mean NOTHING was committed.
      // A store that pushes remotely and then persists locally (runRemote's gateStore) must
      // contain its post-commit failures itself — the cloud proposal is live and the human can
      // see it, so surfacing that partial failure here would misreport a real park as a failed
      // push. The gateStore does exactly that: it swallows the local record-write failure and
      // relies on row reconciliation at the next attach.
      return { proposed: false, parkFailed: true };
    }
    // From here the park is REAL — the store holds the proposal (and on the remote path the
    // durable record is already on disk). Every failure below is local housekeeping and must not
    // be reported as a failed park: claiming "FAILED, will be re-pushed" for a proposal the human
    // can already see in their editor is the same class of false signal #88 exists to kill.
    if (!gate && !revertWouldWipe(canonicalText, current)) {
      try {
        await store.saveDoc(canonicalText);
      } catch {
        /* Failed revert: the working copy keeps the edit, where the hydration hash-mismatch guard
           protects it; the next turn re-parks the identical text as a no-op. */
      }
    }
    try {
      await channel.append({
        actor: "agent",
        type: LogEventType.AgentRevisionProposed,
        // proposal_id names WHICH proposal this event parked — the row/record id, the same one
        // the wait output carries. bytes/hash stay as human-auditable descriptors of the text.
        payload: { bytes: utf8Bytes(current), hash: hashBody(current), proposal_id: proposalId },
      });
    } catch {
      // The park stands without its event — the proposal row/record is the durable signal now.
      // Report it, though: the event is also what nudges a live editor to show the review panel,
      // so the caller should tell the agent the proposal may stay invisible to the human until
      // their editor next reloads.
      return { proposed: true, proposalId, eventLogged: false };
    }
    return { proposed: true, proposalId };
  } else if (ev.changed) {
    // Auto-accept (auto mode, or review mode with comment-only changes): advance the base. On the
    // plugin path that means pushing into the plugin's doc; otherwise advance the persisted canonical.
    if (gate) await gate.applyRevision(current);
    else {
      await store.setCanonical(current);
      await withdrawOwnPending(store);
    }
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: utf8Bytes(current) } });
  }
  return { proposed: false };
}

/**
 * Would reverting the working file to `canonicalText` replace real content with a blank body?
 * (#95) `open` on a fresh path seeds an EMPTY canonical, so on a brand-new doc whose first
 * content arrives from the agent, the quarantine revert used to materialize that empty canonical
 * over the only copy of the text — killing the session (SIGTERM) before the first human action
 * then left the working file at 0 bytes, with the content surviving only in the proposal sidecar.
 * When the revert would be a total wipe (blank canonical body over a non-blank working body),
 * skip it: the proposal is already parked and the working file keeps the text, exactly like the
 * failed-revert path below — the next turn re-parks the identical text as a no-op, and the
 * human's accept still writes canonical. An open/wait must never write the working file emptier
 * than what it read; only a real human decision may.
 */
function revertWouldWipe(canonicalText: string, current: string): boolean {
  const blank = (text: string): boolean => {
    try {
      return parse(text).body.trim() === "";
    } catch {
      return text.trim() === ""; // unparseable comment block — judge the raw text
    }
  };
  return blank(canonicalText) && !blank(current);
}

/** An edit that lands directly moots the caller's own parked proposal, if any — retract it. */
async function withdrawOwnPending(store: DocumentStore): Promise<void> {
  const mine = await store.myPendingProposal();
  if (mine) await store.withdrawProposal(mine.id);
}
