# Contributing

Thanks for your interest in agent-planner.

## License & CLA

agent-planner is licensed under the **GNU Affero General Public License v3.0 or
later** (see `LICENSE`).

By contributing, you agree to the project's **Contributor License Agreement
(CLA)**, which grants the project a broad, sublicensable license to your
contribution so the project can be relicensed and offered under commercial
terms. The CLA is administered via the cla-assistant bot on pull requests — you
will be prompted to sign before your first contribution can be merged.

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
