# CLA signatures

This branch stores Contributor License Agreement signatures (`cla.json`) for the
CLA Assistant GitHub Action (`.github/workflows/cla.yml` → `branch: cla-signatures`).

It is intentionally kept off `main`: `main` has a ruleset requiring all changes via
pull request, but the action records signatures by committing directly — so it writes
here, an unprotected branch, instead. Do not protect this branch.
