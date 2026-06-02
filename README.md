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

> **Requires a recent Node.js (20 or newer).** Published npm packages are on the way;
> until then, build from source. Once published, agents install the CLI with:
>
> ```bash
> inplan --version || npm install -g inplan
> ```

**From source** (TypeScript monorepo, npm workspaces):

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

Plans are just Markdown files named `<name>.plan.md`. The intended workflow is
collaborative: a coding agent drafts the plan and poses questions as inline comments,
you answer them in the editor, and the agent revises — looping until you finish.

The easiest way in is the bundled **agent skill** (`skill/SKILL.md`): point your
coding agent at it and ask for a plan. The agent writes `<name>.plan.md`, opens the
editor, and iterates with you through comments. Under the hood it uses the CLI:

```bash
inplan open  <file>           # open the editor and block until the human acts
inplan wait  <file>           # wait for the next human action (resume the loop)
inplan signal <file> --done   # signal the plan looks ready (the human still decides)
inplan upload <file>          # push the plan to the cloud workspace (hosted edition)
```

`inplan open` launches the desktop editor named by the `INPLAN_APP_CMD` environment
variable (the built `@inplan/app`); without it the CLI runs headless. To run the
editor on its own during development:

```bash
npm run dev -w @inplan/app
```

The editor keeps its sidecars (control log, canonical base, backups) in an `.inplan/`
directory next to the file — never edit those by hand.

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

## License

inplan is **dual-licensed**:

- **Open source:** [AGPL-3.0-or-later](./LICENSE).
- **Commercial:** a separate license from CrazyIdeaStudio, Inc. for
  proprietary or SaaS use without the AGPL's copyleft — see
  [`LICENSING.md`](./LICENSING.md), contact **licensing@crazyideastudio.com**.

Contributions require signing the [CLA](./CLA.md). See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
