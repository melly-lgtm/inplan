# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Shared authorship-rule definitions, sourced by BOTH the CI range check
# (.github/scripts/check_authorship.sh) and the local commit-msg hook
# (.githooks/commit-msg) so the rule set is defined exactly once and can never drift
# between "caught at commit time" and "caught at PR time". Adding a tool here covers both.
#
# AI/bot identity clues, matched case-insensitively against author/committer
# "name <email>". `[bot]` catches GitHub App bot accounts (cursor[bot], etc.).
AUTHORSHIP_BOT_RE='\[bot\]|cursoragent|bugbot|devin|copilot|claude|anthropic|chatgpt|openai|gpt-[0-9]|codeium|tabnine|amazon[- ]?q|gemini-'

# Machine-authorship markers in the commit body. BOTH the "generated with …" and the
# Co-authored-by branches reuse BOT_RE so they screen against the same identity set as the
# author/committer (no drift). The Co-authored-by branch is anchored to line start (^) so it
# matches a real git trailer, not prose mentioning "Co-authored-by:". `codex`/`gpt` are
# marker-only extras: too generic to match a human's name/email, but unambiguous after the
# literal "generated with ".
AUTHORSHIP_MARK_RE="generated with .*(${AUTHORSHIP_BOT_RE}|codex|gpt)|🤖 generated|^ *co-authored-by:.*(${AUTHORSHIP_BOT_RE})"
