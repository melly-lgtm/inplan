# inplan

**InPlan (Interactive Planning Editor)** brings structure and accountability to
AI-assisted software development. While AI coding agents are excellent at generating
code quickly, they struggle when requirements evolve, context grows, and decisions
accumulate over time. Traditional AI coding workflows are built around linear
conversations, making it difficult to track requirements, rationale, implementation
status, and changes in a way that remains consistent as a project grows.

InPlan introduces **Planning-Driven Development (PDD)**, where requirements become a
living, collaborative document that evolves alongside the code. Inspired by the
collaborative experience of document editors and code reviews, it enables teams to
continuously refine plans, capture decisions, manage requirement updates separately
from bug fixes, and maintain a reliable source of truth that neither humans nor AI
agents can consistently hold in memory. The result is less implementation drift,
safer refactoring, better alignment between intent and code, and a development
process that remains adaptable without sacrificing correctness.

> A Markdown workspace where you and your coding agent plan together. The hosted
> edition lives at **[inplan.ai](https://inplan.ai)**; this repository is the open
> core you can run yourself.

## Demo

[![inplan — plan with your coding agent](https://github.com/melly-lgtm/inplan/releases/latest/download/inplan-demo.gif)](https://github.com/melly-lgtm/inplan/releases/latest/download/inplan-demo.mp4)

Comment on a specific sentence and discuss it with the agent in a thread; when it
revises the plan, review the diff and apply it like a PR.
▶ **[Watch with narration](https://github.com/melly-lgtm/inplan/releases/latest/download/inplan-demo.mp4)**

## How it works

You and the agent edit one Markdown plan, like two people in a shared document:

1. **Draft the plan.** Write requirements in Markdown. The agent proposes structure
   and raises open questions as inline comments.
2. **Refine together.** Comment, answer, and revise. Accept the agent's changes
   automatically (**Auto-accept**) or vet each one (**Review**); work turn-by-turn
   (**Turn**) or in real time (**Instant**). The plan converges into a shared
   decision record.
3. **Build with confidence.** The agent implements against the agreed, versioned
   source of truth — so refactoring is safer and intent stays aligned with the code.

Comments live in the document itself, so the plan and its rationale travel together
and stay reviewable in Git.

## Install

**Requires Node.js 22 or newer.** Install the CLI from npm — it bundles the desktop
editor and the agent skill:

```bash
npm install -g inplan
inplan --version
```

This puts the `inplan` command on your PATH, bundles the **desktop editor** (launched by
`inplan open`), and installs the **agent skill** into any coding agents it detects
(Claude Code, Pi, Codex — set `INPLAN_NO_SKILL_INSTALL=1` to skip, or run
`inplan install-skill` later). A coding agent can self-install the same way:

```bash
inplan --version || npm install -g inplan
```

**From source** (TypeScript monorepo, npm workspaces) — for development:

```bash
git clone https://github.com/melly-lgtm/inplan.git
cd inplan
npm install
npm run build
```

Packages: `@inplan/core` (pure, embeddable editor + plan-format logic),
`@inplan/cli` (the `inplan` command — the agent's side of the loop), and
`@inplan/app` (the Electron editor — the human's side).

## Quick start

You don't run `inplan` yourself — your **coding agent** does. There are two steps:

**1. Install** (once) — this also drops the agent skill into your coding agent (Claude
Code, Pi, Codex):

```bash
npm install -g inplan
```

**2. Ask your agent to plan**, in plain language — for example:

> Let's plan a tic-tac-toe game.
>
> Plan the auth rewrite with me.

The skill triggers on any "plan X" request: your agent writes `<name>.plan.md`, **opens
the inplan editor**, and poses its open questions as inline comments. You read the draft,
**answer in the editor** (reply to comments, pick a choice chip, or edit the text
directly), and the agent revises and replies — back-and-forth, like two people on a
shared doc — until you close the session. Plans are plain Markdown, so they render and
diff anywhere.

That's it. (If your agent doesn't pick it up automatically, just point it at the bundled
skill, `skill/SKILL.md`, and ask again.)

<details>
<summary>Under the hood / development</summary>

The agent drives the loop through the CLI — `inplan open <file>` (open the editor and
block until you act), `inplan wait <file>` (resume after the next action), `inplan signal
<file> --done` (suggest the plan is ready; you still decide). When installed from npm,
`inplan open` launches the **bundled** desktop editor.

From a **source checkout**, set `INPLAN_APP_CMD` to your built `@inplan/app` (or the CLI
runs headless); run the editor standalone with `npm run dev -w @inplan/app`.

The editor keeps its sidecars (control log, canonical base, backups) centrally under
`~/.inplan/sidecars/<key>` (where `<key>` is derived from the document's absolute path;
override the root with `INPLAN_HOME` or `INPLAN_SIDECAR_DIR`) — never edit those by hand.

</details>

## Document format

A commented span is an inline Markdown link whose href is the comment id; the
comments themselves live in a single trailing HTML-comment block (one JSON array):

```markdown
The plan should [use Postgres](#cmt-abfdb1) for storage.

<!--inplan
[
  { "id": "cmt-abfdb1", "author": "User Name <email@email.com>",
    "date": "2026-05-28T13:34:00Z", "resolved": false,
    "text": "The comment content left by the user." },

  { "id": "cmt-bbf137", "parentId": "cmt-abfdb1", "author": "User Name <email@email.com>",
    "date": "2026-05-28T13:44:00Z", "resolved": false, "text": "The reply." },

  { "id": "cmt-1e2lef", "anchor": "doc", "author": "User Name <email@email.com>",
    "date": "2026-05-28T14:34:00Z", "resolved": false, "text": "A document-level comment." }
]
-->
```

- **Span comment** — exactly one in-body `[text](#cmt-id)` link.
- **Reply** — carries `parentId`, no link.
- **Document-level comment** — `"anchor": "doc"`, no link.
- A **question** adds `"question": { "multiSelect": <bool>, "choices": [...] }`; the
  human answers by selecting choices (the answer records `"selected": [...]`).

Because the format is plain Markdown plus one HTML comment, a plan renders fine in any
Markdown viewer and diffs cleanly in code review.

## Project status

inplan **aims** to support every combination of:

- **OS** — macOS and Windows
- **Cadence** — turn-taking and instant modes
- **Agent** — Claude Code, Codex, and Pi

…but so far it is **primarily developed and tested on macOS, in turn mode, with Claude Code**.
The other operating systems, modes, and agents are wired but lightly exercised, so expect
rough edges there.

**Contributions are very welcome** — especially anything that broadens and hardens support for
the OSes, modes, and agents above. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

inplan is **dual-licensed**:

- **Open source:** [AGPL-3.0-or-later](./LICENSE).
- **Commercial:** a separate license from CrazyIdeaStudio, Inc. for
  proprietary or SaaS use without the AGPL's copyleft — see
  [`LICENSING.md`](./LICENSING.md), contact **licensing@inplan.ai**.

Contributions require signing the [CLA](./CLA.md). See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
