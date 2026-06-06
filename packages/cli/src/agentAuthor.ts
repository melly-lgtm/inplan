// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent's comment-authorship name. When the agent declares its model
// (`--model "Opus 4.8"`), the author is model-qualified — "Opus 4.8 <claude@inplan.ai>"
// — so a thread records *which* model wrote it and the editor can show the model.
// The email's local part is the model's family/vendor (claude, openai, gemini …),
// inferred from the model name; `wait` echoes the whole string so presence and
// authorship never drift. The agent should copy this value verbatim into the
// `author` field of every comment it writes.

/** Map a free-form model name to its vendor/family local-part for the @inplan.ai address. */
function vendorOf(model: string): string {
  const s = model.toLowerCase();
  if (/\b(opus|sonnet|haiku)\b|claude/.test(s)) return "claude";
  if (/\bgpt\b|\bo[1-9]\b|codex|openai/.test(s)) return "openai";
  if (/gemini|bard|palm|google/.test(s)) return "gemini";
  if (/grok|xai/.test(s)) return "grok";
  if (/llama|meta/.test(s)) return "meta";
  if (/mistral|mixtral|magistral/.test(s)) return "mistral";
  if (/deepseek/.test(s)) return "deepseek";
  if (/qwen/.test(s)) return "qwen";
  return "agent";
}

export function agentAuthorFor(model?: string): string {
  const m = model?.trim();
  return m ? `${m} <${vendorOf(m)}@inplan.ai>` : "Agent <agent@inplan.ai>";
}
