// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent's comment-authorship name. When the agent declares its model
// (`--model "Opus 4.8"`), the author is model-qualified — so a thread records
// *which* model wrote it, and the editor's agent indicator can show the model.
// `wait` echoes this so presence + authorship never drift.

export function agentAuthorFor(model?: string): string {
  const m = model?.trim();
  return m ? `Agent (${m}) <agent@inplan>` : "Agent <agent@inplan>";
}
