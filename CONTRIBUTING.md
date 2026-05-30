# Contributing

Thanks for your interest in agent-planner.

## License & CLA

agent-planner is **dual-licensed**: open source under the **GNU Affero General
Public License v3.0 or later** (see [`LICENSE`](./LICENSE)), or under a
**commercial license** from CrazyIdeaStudio, Inc. for proprietary/SaaS use — see
[`LICENSING.md`](./LICENSING.md).

By contributing, you agree to the project's **Contributor License Agreement**
(see [`CLA.md`](./CLA.md)), which grants CrazyIdeaStudio, Inc. a broad,
sublicensable license to your contribution so the project can be offered under
both licenses. The CLA is administered by the **cla-assistant** bot on pull
requests — on your first PR you'll be prompted to sign by commenting:

> I have read the CLA Document and I hereby sign the CLA

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
- `packages/cli` — the `agent-planner` CLI (`open` / `wait` / `signal`)
- `packages/app` — the Electron editor
- `skill/` — the agent skill
