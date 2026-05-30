---
name: agent-planner
description: Use when drafting a planning, PRD, or design document that a human should review interactively. Saves the plan as *.plan.md and opens it in the agent-planner editor for inline-comment collaboration — the agent drafts and poses questions as comments, the human comments/answers, the agent revises — looping until the human completes the session.
---

# agent-planner

Collaborate with the human on a planning document through inline comments, like
two people on a shared doc. You draft the plan and pose open questions as
comments; the human reviews, edits, and answers; you revise. Repeat until the
human completes the session.

## Install (once)

Check for the CLI and install it if missing:

    agent-planner --version || npm install -g agent-planner

(If the unscoped name is unavailable, install `@cis/agent-planner`.)

## File convention

Save plans as `<name>.plan.md`. The editor keeps its sidecars in an
`.agent-planner/` directory next to the file (control log, canonical base,
backups) — never edit those by hand.

## Document format

Comments live in a single trailing HTML-comment block holding a JSON array. An
anchored comment is an inline Markdown link whose href is the comment id:

    The plan should [use Postgres](#cmt-abfdb1) for storage.

    <!--agent-planner
    [
      { "id": "cmt-abfdb1", "author": "Agent <agent@agent-planner>",
        "date": "2026-05-29T00:00:00Z", "resolved": false,
        "text": "Confirm the datastore?",
        "question": { "multiSelect": false, "choices": [
          { "label": "Postgres", "description": "JSONB + scale" },
          { "label": "SQLite", "description": "simplest" } ] } }
    ]
    -->

- **Span comment**: exactly one in-body `[text](#cmt-id)` link; no `parentId`/`anchor`.
- **Reply / answer**: `parentId` set, no link. An answer carries `selected: [labels]`.
- **Document-level**: `anchor: "doc"`, no link.
- **Question**: `question.multiSelect` false = pick one (radio), true = pick many
  (checkbox); the human may also answer with free text.
- Generate ids as `cmt-` + 6 base36 characters.

## Turn-taking & control — read this first

This is **turn-based**. The turn belongs to exactly one party at a time:

- After you (the agent) `open` or revise and call `wait`, the turn is the
  **human's** — the editor is theirs to use.
- When the human clicks **Finish turn**, the turn becomes **yours**. In Turn mode
  the human's editor **locks** ("Agent is thinking…"); they **cannot edit** until
  you take your turn and hand control back.

Therefore, when `wait` returns `actions`, **it is your turn and the human is
blocked, waiting for you.** Do not idle and never tell the human to act. Promptly
take your turn, then call `wait` again. **Calling `wait` is how you hand control
back** — it logs an `agent_revised` event that unlocks the human's editor. You
must call `wait` after *every* turn, **even if you changed nothing**; otherwise
the human stays locked out.

`wait` owns the cursor, diffs, and control-log writes. **Your only jobs are: edit
the plan, then call `wait`.** Do not pass `--cursor` and do not hand-manage it.

## The loop

1. Write `<name>.plan.md` with the plan body and a comment block. Pre-populate
   your open questions as comments (use `question` + `choices` where the answer
   is a choice).
2. Launch the editor **in the background, with no timeout** — do not foreground
   it, do not poll:

       agent-planner open <name>.plan.md

   It opens the editor and blocks until the human acts, then prints one JSON
   line to stdout and exits. Re-invoke yourself when it returns.
3. Read the printed JSON `status`:
   - `actions` — the human acted. Re-read the `.md` for current state and use
     `entries` to see what changed; note the `cursor`.
   - `confirm_required` — your edit removed an anchored comment (`lost`). If
     intentional, re-run with `--confirmed-comment-deletion=<ids>`; otherwise
     restore the anchor link and try again.
   - `integrity_error` — the document violates the comment grammar (`errors`).
     Fix it and wait again.
   - `editor_closed` — the editor window went away. The session is over; stop.
   - `closed` — the human ended the session (Complete & quit). Stop.
4. **It is now your turn; the human is locked, waiting.** Act on the changes,
   **respecting the mode**:
   - **Turn mode**: you may revise the document body and reply/resolve comments.
   - **Instant mode**: only add to comment threads (reply/resolve/answer); do
     **not** rewrite the body.
   Reply by appending a comment with `parentId`. Resolve by setting
   `"resolved": true`. Read `selected` on the human's answers. If nothing needs
   changing, that's fine — you still take your (empty) turn and proceed to step 5.
5. **Hand control back: call `wait` again** (no `--cursor` — it self-manages).
   This unlocks the human's editor and blocks until their next turn. Do this
   after *every* turn, even an empty one:

       agent-planner wait <name>.plan.md

6. When you believe the plan is ready, signal it (the human still decides):

       agent-planner signal <name>.plan.md --done

   Then wait again. Stop only on `status: closed` or `editor_closed`.

## Authorship

Never add AI attribution to the document, commit messages, code, or anything
committed — always use the human's identity. (See AGENT.md.)
