#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Authorship guardrail. Fails the build if any commit in the PR range was
# authored, committed, or co-authored by a known AI/bot identity, or carries an
# AI-generation marker (a "Generated with …" line or the 🤖 trailer). This is the
# automated form of keeping the repository's history unambiguously human-authored,
# which the IP value depends on (see CONTRIBUTING.md and docs "Licensing & IP").
#
# Honest limit: no check can prove code wasn't AI-*assisted*. This enforces
# explicit human attribution + a sign-off attestation + maintainer review, which
# is the defensible, auditable bar.
set -euo pipefail

BASE="${1:?usage: check_authorship.sh <base-sha> <head-sha>}"
HEAD="${2:?usage: check_authorship.sh <base-sha> <head-sha>}"

# AI/bot identity clues, matched case-insensitively against author/committer
# "name <email>". `[bot]` catches GitHub App bot accounts (cursor[bot], etc.).
BOT_RE='\[bot\]|cursoragent|bugbot|devin|copilot|claude|anthropic|chatgpt|openai|gpt-[0-9]|codeium|tabnine|amazon[- ]?q|gemini-'
# Machine-authorship markers in the commit body. BOTH the "generated with …" and
# the Co-authored-by branches reuse BOT_RE so they screen against the same identity
# set as the author/committer (no drift — adding a tool to BOT_RE covers all three).
# The Co-authored-by branch is anchored to line start (^) so it matches a real git
# trailer, not prose that merely mentions "Co-authored-by:" (e.g. this script's own
# commit messages). `codex`/`gpt` are marker-only extras: too generic to match a
# human's name/email, but unambiguous after the literal "generated with ".
MARK_RE="generated with .*(${BOT_RE}|codex|gpt)|🤖 generated|^ *co-authored-by:.*(${BOT_RE})"

fail=0
# Fail closed: if rev-list errors (bad/missing refs, shallow clone), don't let the
# empty substitution skip the loop and silently pass. An empty *range* (no commits)
# is fine — that's a successful exit with no output.
if ! revs="$(git rev-list "$BASE..$HEAD")"; then
  echo "::error::git rev-list failed for ${BASE}..${HEAD} — cannot verify authorship"
  exit 1
fi
for sha in $revs; do
  author=$(git show -s --format='%an <%ae>' "$sha")
  committer=$(git show -s --format='%cn <%ce>' "$sha")
  body=$(git show -s --format='%B' "$sha")
  if printf '%s\n%s\n' "$author" "$committer" | grep -qiE "$BOT_RE"; then
    echo "::error::commit ${sha} has an AI/bot author or committer — author: ${author}, committer: ${committer}"
    fail=1
  fi
  if printf '%s\n' "$body" | grep -qiE "$MARK_RE"; then
    echo "::error::commit ${sha} carries an AI-authorship marker (Co-authored-by / 'Generated with' / 🤖)"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Authorship check failed: all contributions must be human-authored under the contributor's own identity (see CONTRIBUTING.md)."
  exit 1
fi
echo "Authorship check passed: no AI/bot author, committer, or co-author markers found in ${BASE}..${HEAD}."
