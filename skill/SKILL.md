---
name: inplan
description: Use when the user wants to create or refine a planning, PRD, or design document collaboratively, with interactive human review. Trigger on requests like "plan X", "let's plan …", "create a plan for …", "design Y together", or "draft a PRD/design doc" — in general, any request pairing the verb "plan" with a topic (e.g. "plan a tic-tac-toe game"). Saves the document as *.plan.md and opens it in the inplan editor for inline-comment collaboration — the agent drafts and poses questions as comments, the human comments/answers, the agent revises — looping until the human ends the session. Do not confuse with writing-plans, which breaks an already-agreed spec into implementation tasks; inplan is for co-developing the spec/design itself.
# The human reviews every change in the inplan editor, so the agent's edits to the plan
# file + sidecars and the inplan CLI are auto-approved while this skill is active (no
# per-edit prompts). Scoped to plan files, the ~/.inplan sidecars, and the inplan CLI only.
allowed-tools:
  - Bash(inplan *)
  - Edit(**/*.plan.md)
  - Write(**/*.plan.md)
  - Read(~/.inplan/**)
  - Edit(~/.inplan/**)
  - Write(~/.inplan/**)
---

# inplan

Collaborate with the human on a planning document through inline comments, like
two people on a shared doc. You draft the plan and pose open questions as
comments; the human reviews, edits, and answers; you revise. Repeat until the
human completes the session.

## Install (once)

Check for the CLI and install it if missing:

    inplan --version || npm install -g inplan

(If the unscoped name is unavailable, install `@cis/inplan`.)

**If `open` runs headless** (it prints "the bundled editor's Electron runtime is
unavailable"): the npm package installed but Electron's **binary** didn't download — a
proxy/firewall/AV blocked it, or `ignore-scripts` is set. Do **not** `npm install -g
electron` separately (inplan won't use it). Re-download inplan's own copy, using the path
the message prints:

    npm rebuild electron --prefix "$(npm root -g)/inplan"               # macOS/Linux
    npm rebuild electron --prefix "%APPDATA%\npm\node_modules\inplan"   # Windows (cmd)

If the download itself is blocked, set a mirror first (`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`,
`set ELECTRON_MIRROR=…` on Windows), then rebuild. The loop still works headless until then,
but the human can't review in the GUI — surface the fix to them and proceed.

## File convention

Save plans as `<name>.plan.md`. The editor keeps its sidecars under
`~/.inplan/sidecars/<key>/` (the control log `log.jsonl`, the canonical base
`canonical.md`, any parked proposal `proposed.md`, backups, and `status.json`) —
the `inplan` CLI owns these; never edit them by hand.

## Auto-approval (review happens in the app)

The human reviews every change you make inside the inplan editor, so you don't need
the coding agent's per-edit confirmation for this workflow. This skill's `allowed-tools`
auto-approve — **while the skill is active** — exactly: the `inplan` CLI, editing/writing
`*.plan.md`, and reading/writing the `~/.inplan/` sidecars. Nothing else is granted, and
your other tools still prompt as usual.

For persistent auto-approval across sessions, run `inplan install-skill` — it merges the
same scoped rules into `~/.claude/settings.json` (`permissions.allow` +
`additionalDirectories: ["~/.inplan/"]`). Set `INPLAN_NO_SKILL_INSTALL=1` to skip.

## Document format

Comments live in a single trailing HTML-comment block holding a JSON array. An
anchored comment is an inline Markdown link whose href is the comment id:

    The plan should [use Postgres](#cmt-abfdb1) for storage.

    <!--inplan
    [
      { "id": "cmt-abfdb1", "author": "Opus 4.8 <claude@inplan.ai>",
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
- **`author`**: sign **every** comment you write with **your own model identity**, so
  the human sees which model is talking. Always pass `--model "<your model>"` (e.g.
  `--model "Opus 4.8"`) on `open`/`wait`; the wait result echoes the exact string to
  use back as **`agentAuthor`** (e.g. `"Opus 4.8 <claude@inplan.ai>"`). Copy that
  value verbatim into the `author` field — never hardcode the generic
  `"Agent <agent@inplan>"`.

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

       inplan open <name>.plan.md

   It opens the editor and blocks until the human acts, then prints one JSON
   line to stdout and exits. Re-invoke yourself when it returns.

   **Pass `--model <your-model-name>`** on `open`/`wait` (e.g. `--model "Opus 4.8"`)
   so the editor shows which model is attached and stamps your comments with a
   model-qualified author. Use the same value every turn.
3. Read the printed JSON `status` (it also carries `mode`, `humanLocked`, and
   `settings` — the current materialized user settings, e.g. `autoResolve`):
   - `your_turn` — **Turn mode**: the human finished their turn and their editor
     is **locked**; the turn is yours. Re-read the `.md`, act, then **call `wait`
     to hand control back** (this unlocks them). `humanLocked: true`.
   - `activity` — **Instant mode**: the human acted but is **editing live and is
     not blocked**. React by **appending to comment threads only** (reply/resolve/
     answer) — do **not** rewrite the body — then call `wait` again to keep
     listening. `humanLocked: false`.
   - `confirm_required` — your edit removed an anchored comment (`lost`). If
     intentional, re-run with `--confirmed-comment-deletion=<ids>`; otherwise
     restore the anchor link and try again.
   - `integrity_error` — the document violates the comment grammar (`errors`).
     Fix it and wait again.
   - `closed` — the planning session is over; stop the loop. `reason` says what to do next:
     - `completed` — the human chose **"Switch agent to build mode"** on quit: planning
       is done and they want you to **implement the plan**. Stop the wait loop and start
       building what the document specifies (it's no longer a planning doc — act on it).
     - `window_closed` — they just closed the editor; **stop** and take no further action.
     - `crashed_or_killed` — the editor vanished with no close log; surface this to the human.
   - `superseded` — a newer `wait` took over this document (only one waiter runs at
     a time). This one stepped down; **do nothing** — the live waiter is in charge.
   - `navigated` — the human followed an in-window link to a **different document**;
     `path` is the new file. This `wait` stepped down. **Follow them:** call
     `wait <path>` (pass your `--model`) to re-attach there and resume the loop —
     you move with the human to the linked doc.
   **Run only one `wait` per document.** Launch `open` / `wait` as their **own
   long-lived background process** — do **not** background them with a shell `&`
   inside a short-lived wrapper command, or the wrapper exits and its process tree
   (including your waiter) is reaped. If your `wait` ever exits **without** a
   `closed` status while the editor is still open — e.g. it was `superseded`, or the
   process was terminated by the environment — simply **call `wait` again** to resume
   monitoring; don't treat it as the session ending.
4. Act on what changed (`your_turn` → the human is locked and waiting; `activity`
   → they're still editing live), **respecting the mode**:
   - **Turn mode**: you may revise the document body and reply/resolve comments.
   - **Instant mode**: only add to comment threads (reply/resolve/answer); do
     **not** rewrite the body.
   Reply by appending a comment with `parentId`. Read `selected` on the human's
   answers. If nothing needs changing, that's fine — you still take your (empty)
   turn and proceed to step 5.
   **Resolving:** by default, set `"resolved": true` once you've incorporated a
   comment. But honor `settings.autoResolve` from the wait result (it is always
   present — the current value, no log-scanning needed): if it's `false`, do
   **not** auto-resolve — instead reply that the thread can be resolved and leave
   it `resolved: false` for the human to resolve.
5. **Relay a one-line summary, then hand control back by calling `wait` again**
   (no `--cursor` — it self-manages), then loop to step 3. The `message` keeps the
   human's status-bar history populated; the `wait` unlocks their editor and blocks
   until their next turn. Do both after *every* turn, even an empty one:

       inplan message <name>.plan.md "Summarized what you did this turn."
       inplan wait <name>.plan.md

   `your_turn` and `activity` are **not** stop conditions — you always loop back
   and keep waiting. The **only** thing that ends the loop is `status: closed`.

6. When you believe the plan is ready, signal it (the human still decides):

       inplan signal <name>.plan.md --done

   Then wait again. Stop only on `status: closed`.

## Keeping the human informed

The human can't see your terminal — anything you'd "say" about your work is
invisible to them unless you relay it. Mirror it into the editor with `inplan
message`; it appears as a note in the status bar (the human clicks it for the
full session history). Use it for human-facing context, not your raw reasoning:

    inplan message <name>.plan.md "Reworked the datastore section based on your Redis pick."

**Relay a one-line summary on every turn**, right before you `wait` — what you
changed and why, or that you only replied. This is what populates the status-bar
history, so the human can always see how you responded to each of their actions.
Also relay when you start a long step. Keep each to a sentence or two. It's
informational only — it never ends the loop or hands over the turn.

## Authorship

Never add AI attribution to the document, commit messages, code, or anything
committed — always use the human's identity. (See AGENT.md.)
