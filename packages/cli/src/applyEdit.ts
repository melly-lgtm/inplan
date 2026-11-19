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
  ctx: { current: string; canonicalText: string; quarantine: boolean; gate: PluginGate | null; onlyIfUnmoved?: boolean },
): Promise<{ proposed: boolean; proposalId?: string; parkFailed?: boolean; eventLogged?: boolean; withdrew?: boolean; stale?: boolean }> {
  const { current, canonicalText, quarantine, gate, onlyIfUnmoved } = ctx;
  /**
   * Has the document moved under this decision? Only a caller that does not own the turn asks —
   * the live watcher, which decides against a snapshot while the human may be saving.
   *
   * The editor's save writes the file and then the canonical, so checking BOTH as late as possible
   * catches it from either side. It is a check, not a lock: the store has no compare-and-set, so a
   * save landing between this read and the write below is still possible. What it buys is that the
   * only surviving window is instants wide and no longer spans the base read, the history read and
   * the lock probe — and the caller skips rather than overwrites whenever it is caught.
   */
  const moved = async (): Promise<boolean> => {
    if (!onlyIfUnmoved) return false;
    try {
      const [doc, canonical] = await Promise.all([store.loadDoc(), store.getCanonical()]);
      return doc !== current || (canonical !== null && canonical !== canonicalText);
    } catch {
      return true; // cannot vouch for the document ⇒ do not write over it
    }
  };
  let withdrew = false;
  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects. On the plugin path push the result
    // into the plugin's doc (it owns the .md); otherwise write the file + canonical.
    let viaPlugin = false;
    if (gate) viaPlugin = (await gate.applyRevision(ev.acceptedText)) !== "local";
    else {
      await store.saveDoc(ev.acceptedText);
      await store.setCanonical(ev.acceptedText);
      withdrew = await withdrawOwnPending(store, canonicalText, ev.acceptedText);
    }
    if (!(await logEdit(channel, { removed: ev.removedIds }, viaPlugin))) return { proposed: false, eventLogged: false, ...(withdrew ? { withdrew } : {}) };
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
    if (await moved()) return { proposed: false, stale: true };
    let viaPlugin = false;
    if (gate) viaPlugin = (await gate.applyRevision(current)) !== "local";
    else {
      await store.setCanonical(current);
      withdrew = await withdrawOwnPending(store, canonicalText, current);
    }
    if (!(await logEdit(channel, { bytes: utf8Bytes(current) }, viaPlugin))) return { proposed: false, eventLogged: false, ...(withdrew ? { withdrew } : {}) };
  }
  return { proposed: false, ...(withdrew ? { withdrew } : {}) };
}

/**
 * Must a Review-mode agent edit be PARKED for the human, or may it land directly?
 *
 * Review mode exists so the agent can never overwrite the human's document unseen — so it keys on
 * there being a document to overwrite. The first content of a brand-new doc is the one case where
 * there isn't: `open` seeds an EMPTY canonical, and the agent fills it in. Parking that fill leaves
 * the human staring at the empty document the editor was launched on, with the whole plan behind a
 * review of nothing-vs-everything; nothing is lost by landing it, because the base holds no human
 * text to lose. (The same blank base is why the quarantine revert has to be skipped — see
 * revertWouldWipe — so this is that hazard removed at its source rather than patched downstream.)
 *
 * "Nothing to overwrite" has to mean the whole document, not just its body. A blank body can still
 * carry document-level comments — the human opens the empty doc and writes what they want covered —
 * and `detectLostComments` reports only orphaned SPAN comments, so a fill that dropped those doc
 * comments would land them into oblivion with neither a review nor a confirm gate. An empty base is
 * therefore an empty BODY and no comments; anything else parks as it always did. An unparseable
 * base isn't provably empty, so it parks too.
 *
 * Everything else follows the recorded acceptance: in review mode a body change against a
 * non-empty canonical parks; a comment-only change never does.
 */
export function shouldQuarantine(acceptance: "auto" | "review", canonicalText: string, current: string): boolean {
  if (acceptance !== "review") return false;
  if (emptyDocument(canonicalText)) return false; // the document's first content — nothing to protect
  return body(canonicalText) !== body(current);
}

/** Is there no document here at all — empty body AND no comments? Unparseable ⇒ false: a base we
 *  can't read is not one we can claim is empty. */
function emptyDocument(text: string): boolean {
  try {
    const doc = parse(text);
    return doc.body.trim() === "" && doc.comments.length === 0;
  } catch {
    return false;
  }
}

/** A document's body, or its raw text when the comment block won't parse (same fallback as isBlank). */
function body(text: string): string {
  try {
    return parse(text).body;
  } catch {
    return text;
  }
}

/** Is this document's body empty? Exported for the callers that must decide whether an empty base
 *  is one they can vouch for. */
export function emptyBody(text: string): boolean {
  return isBlank(text);
}

/** Is this document's body empty (an unparseable comment block ⇒ judge the raw text)? */
function isBlank(text: string): boolean {
  return body(text).trim() === "";
}

/**
 * Would reverting the working file to `canonicalText` replace real content with a blank body?
 * (#95) `open` on a fresh path seeds an EMPTY canonical, so on a brand-new doc whose first
 * content arrives from the agent, the quarantine revert used to materialize that empty canonical
 * over the only copy of the text — killing the session (SIGTERM) before the first human action
 * then left the working file at 0 bytes, with the content surviving only in the proposal sidecar.
 * `shouldQuarantine` now keeps a blank base from parking in the first place, so this is the second
 * line of defence rather than the first — it still guards every caller that decides `quarantine`
 * for itself, and a wipe is not the failure to leave to one check.
 *
 * When the revert would be a total wipe (blank canonical body over a non-blank working body),
 * skip it: the proposal is already parked and the working file keeps the text, exactly like the
 * failed-revert path below — the next turn re-parks the identical text as a no-op, and the
 * human's accept still writes canonical. An open/wait must never write the working file emptier
 * than what it read; only a real human decision may.
 */
function revertWouldWipe(canonicalText: string, current: string): boolean {
  return isBlank(canonicalText) && !isBlank(current);
}

/**
 * Announce a landed edit, reporting a failure rather than throwing it.
 *
 * The write has already happened by the time this runs, so a throw here would unwind a caller that
 * has nothing left to undo — and on the live-fill path it unwound into a catch that discards it,
 * leaving the edit on disk, absent from the control log the editor is driven by, and unmentioned to
 * anyone. The park path has reported this as `eventLogged: false` since #88; a landing deserves the
 * same, because the consequence is the same: the human's editor won't show it until it reloads.
 */
async function logEdit(channel: ControlChannel, payload: Record<string, unknown>, viaPlugin: boolean): Promise<boolean> {
  // `via` records which of the two carriers this edit went out on — the one fact about it that
  // only this process knows, and knows exactly. Through the plugin, the text is in the shared
  // document and nowhere this process wrote; file-backed, it is in the canonical sidecar, which
  // this process advanced a moment ago. The editor needs that to know where to read the edit
  // FROM: the working file is not a safe answer in either case once a plugin is alive, because
  // the plugin overwrites it with its own projection on its own schedule.
  //
  // BOTH carriers are stamped, never just one. An editor must be able to tell "file-backed" from
  // "written by a CLI that predates the stamp": an older CLI still attached across an editor
  // upgrade applies through the plugin and says nothing, and reading the canonical for it would
  // hand back a sidecar the plugin path never advances. Unstamped therefore means "unknown", and
  // the editor treats unknown exactly as it always did.
  //
  // Deliberately NOT a claim about who owns the document or whether an editor is bound. Earlier
  // attempts stamped those and were wrong each time: this process reads the plugin session once,
  // moments after spawning the editor and before the editor has published one, and its gate fails
  // soft for reasons unrelated to ownership. What it did is all it can vouch for.
  //
  // `viaPlugin` is therefore "the push into the plugin succeeded", not "a gate was loaded": a
  // wrapped gate that caught a failed push lands the text in the local files instead, and that
  // edit is file-backed in every way that matters to a reader.
  payload = { ...payload, via: viaPlugin ? "plugin" : "file" };
  try {
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload });
    return true;
  } catch {
    return false;
  }
}

/**
 * An edit that lands directly moots the caller's own parked proposal — but only a BODY edit does.
 *
 * A park reverts the working copy to the base, and the agent's next write is composed from that
 * reverted file, so a comment the agent adds mid-turn lands with the parked revision's body absent
 * from it. Retracting the proposal on that write deleted the revision outright: gone from the
 * working copy (the park reverted it), gone from the pending set (this withdrew it), and never
 * decided by the human. The landing text and the proposal were about different things — one added a
 * comment, the other rewrote the body — and only one of them was kept.
 *
 * So retract only when the landing edit IS that proposal's body — when what landed is the thing the
 * proposal was proposing, and keeping it pending would ask the human to decide something already
 * decided. "The body changed at all" is not that test and quietly fails the same way: `inplan
 * comment --span` writes its anchor link INTO the body, so under auto acceptance a span comment
 * would count as a body edit and retract a revision it has nothing to do with.
 *
 * Anything else leaves the proposal standing. It may go slightly stale (it predates a comment, say),
 * which is a state the reviewer already handles — accepting a proposal merges the live comments
 * rather than overwriting them with the proposal's snapshot.
 *
 * Returns whether a proposal was retracted, so the caller can keep its landing signal honest.
 */
async function withdrawOwnPending(store: DocumentStore, _canonicalText: string, landed: string): Promise<boolean> {
  const mine = await store.myPendingProposal();
  if (!mine) return false;
  if (body(landed) !== body(mine.content)) return false; // a different body: the proposal still stands
  await store.withdrawProposal(mine.id);
  return true;
}
