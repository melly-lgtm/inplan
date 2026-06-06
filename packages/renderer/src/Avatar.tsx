// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Google-Docs-style comment authorship: an avatar circle + the author's name, with
// a hover card revealing the full name, email, and role. The author string is
// "Name <email>" (e.g. "Opus 4.8 <claude@inplan.ai>"); agents are addressed at
// @inplan.ai with the vendor as the local-part. Every agent shows one shared 🤖
// avatar (vendor brand logos are trademarked, so we don't reproduce them); humans
// get an initials circle in a hashed color. The vendor still names the agent in the
// hover card (e.g. "Claude · Anthropic").

import type { JSX } from "react";

export interface ParsedAuthor {
  name: string;
  email: string;
  /** vendor local-part when the author is an @inplan.ai agent (claude, openai, …); else null. */
  vendor: string | null;
}

/** Split "Name <email>" into its parts, tolerating a bare name with no address. */
export function parseAuthor(author: string): ParsedAuthor {
  const m = author.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const name = (m ? m[1].trim() : author.trim()) || (m ? m[2].trim() : author.trim());
  const email = m ? m[2].trim() : "";
  const vend = email.toLowerCase().match(/^([^@]+)@inplan\.ai$/);
  return { name, email, vendor: vend ? vend[1] : null };
}

// Vendor (the @inplan.ai local-part) → display label for the hover card. Every agent
// shares the 🤖 avatar; the label is the only per-vendor distinction.
const VENDOR_LABELS: Record<string, string> = {
  claude: "Claude · Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  grok: "Grok · xAI",
  meta: "Meta Llama",
  mistral: "Mistral AI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
};
const AGENT_LABEL = "AI agent";
const AGENT_EMOJI = "🤖";
const AGENT_BG = "#E8E4DB"; // neutral circle behind the robot emoji

// Stable, pleasant palette for human initials avatars (picked by name hash).
const HUMAN_COLORS = ["#1F8A70", "#2563EB", "#9333EA", "#DB2777", "#D97706", "#0891B2", "#65A30D", "#DC2626"];
function hashIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  // No last name → a single initial (not two letters of the first name).
  return (words[0]?.[0] ?? "?").toUpperCase();
}

interface Look {
  color: string;
  /** what shows inside the circle (the 🤖 emoji for agents, initials for humans) */
  content: string;
  /** role line for the hover card */
  role: string;
  isAgent: boolean;
}
function lookOf(p: ParsedAuthor): Look {
  if (p.vendor) {
    return { color: AGENT_BG, content: AGENT_EMOJI, role: VENDOR_LABELS[p.vendor] ?? AGENT_LABEL, isAgent: true };
  }
  return { color: HUMAN_COLORS[hashIndex(p.name, HUMAN_COLORS.length)]!, content: initials(p.name), role: "You", isAgent: false };
}

/** The avatar circle alone (used inline and, larger, in the hover card). */
export function Avatar({ author, size = 18 }: { author: string; size?: number }): JSX.Element {
  const p = parseAuthor(author);
  const look = lookOf(p);
  return (
    <span
      className="ap-avatar"
      style={{ width: size, height: size, background: look.color, fontSize: Math.round(size * 0.6) }}
      aria-hidden="true"
    >
      {look.content}
    </span>
  );
}

/** Avatar + name with a hover card (name / email / role) — the comment-meta author chip. */
export function AuthorChip({ author }: { author: string }): JSX.Element {
  const p = parseAuthor(author);
  const look = lookOf(p);
  return (
    <span className="ap-author" tabIndex={0}>
      <Avatar author={author} />
      <span className="ap-author-name">{p.name}</span>
      <span className="ap-author-card" role="tooltip">
        <Avatar author={author} size={32} />
        <span className="ap-author-card-info">
          <span className="ap-author-card-name">{p.name}</span>
          {p.email && <span className="ap-author-card-email">{p.email}</span>}
          <span className="ap-author-card-role">{look.role}</span>
        </span>
      </span>
    </span>
  );
}
