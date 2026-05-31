# Contributing

Thanks for your interest in inplan.

## License & CLA

inplan is **dual-licensed**: open source under the **GNU Affero General
Public License v3.0 or later** (see [`LICENSE`](./LICENSE)), or under a
**commercial license** from CrazyIdeaStudio, Inc. for proprietary/SaaS use — see
[`LICENSING.md`](./LICENSING.md).

By contributing, you agree to the project's **Contributor License Agreement**
(see [`CLA.md`](./CLA.md)), which grants CrazyIdeaStudio, Inc. a broad,
sublicensable license to your contribution so the project can be offered under
both licenses. The CLA is administered by the **cla-assistant** bot on pull
requests — on your first PR you'll be prompted to sign by commenting:

> I have read the CLA Document and I hereby sign the CLA

## Human authorship & sign-off

The project's IP value depends on an unambiguously **human-authored** history, so
every contribution must be your own work, contributed under **your own real
identity** — never an AI/bot account.

- **Sign off every commit** with `git commit -s`, which appends a
  `Signed-off-by: Your Name <you@example.com>` line. By signing off you attest to
  the [Developer Certificate of Origin](https://developercertificate.org/) **and**
  that the contribution is your own authorship — not machine-generated and passed
  off as yours.
- **No AI/bot attribution in history.** Do not commit, author, or co-author with
  an AI/bot identity, and do not add `Co-authored-by:` an AI, "Generated with …",
  or `🤖` markers. A CI check (`.github/workflows/authorship.yml`) **fails** any
  PR whose commits carry such an author, committer, co-author, or marker.
- AI tools may *assist* you, but the resulting work is yours: review, understand,
  and take authorship of it. Maintainer review is the final gate.

## Source headers

Add an SPDX header to the top of every new source file:

    // SPDX-License-Identifier: AGPL-3.0-or-later

## Development

```sh
npm install            # install workspace dependencies
npx vitest run         # run the test suite
npm run build          # build all packages
```

The codebase is a TypeScript monorepo:

- `packages/core` — pure-TS document model, parser, integrity, diff, control log
- `packages/cli` — the `inplan` CLI (`open` / `wait` / `signal`)
- `packages/app` — the Electron editor
- `skill/` — the agent skill
