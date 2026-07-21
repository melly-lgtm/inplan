<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Environment variables

inplan reads a handful of environment variables. Most users never need to set
any of them — the defaults are chosen so the CLI and editor "just work". They're
listed here for restricted networks, air-gapped/CI setups, and development from a
source checkout.

## Paths & storage

| Variable | What it does | Default |
| --- | --- | --- |
| `INPLAN_HOME` | Root directory for inplan's own state — sidecars, settings, auth, and the plugin cache. | `~/.inplan` |
| `INPLAN_SIDECAR_DIR` | Overrides just the sidecar location (control log, canonical base, backups). Takes precedence over `INPLAN_HOME` for sidecars. | `<INPLAN_HOME>/sidecars` |

## Editor launch (development / source checkouts)

| Variable | What it does | Default |
| --- | --- | --- |
| `INPLAN_APP_CMD` | Command the CLI runs for `inplan open` instead of the bundled desktop editor. | *(unset — bundled editor when installed; headless from source checkouts)* |

## Electron download (restricted networks)

| Variable | What it does | Default |
| --- | --- | --- |
| `ELECTRON_MIRROR` | Electron's standard mirror URL, honored when the bundled editor's Electron binary must be (re-)downloaded behind a proxy/firewall — e.g. `https://npmmirror.com/mirrors/electron/`. inplan never falls back to a third-party mirror on its own; only a mirror you set here is used. | *(unset — official host)* |
| `INPLAN_NO_ELECTRON_DOWNLOAD` | Set to `1` to skip the Electron auto-download entirely (air-gapped / CI). The loop still runs headless, but the human can't review in the GUI. | *(unset)* |

## Skill installation

| Variable | What it does | Default |
| --- | --- | --- |
| `INPLAN_NO_SKILL_INSTALL` | Set to skip auto-installing the agent skill into detected coding agents on install. Run `inplan install-skill` later to install it manually. | *(unset — skill is installed)* |

## Timing (advanced)

| Variable | What it does | Default |
| --- | --- | --- |
| `INPLAN_DEBOUNCE_MS` | Debounce, in milliseconds, before the CLI reacts to file changes. | `3000` |
| `INPLAN_POLL_MS` | Poll interval, in milliseconds, while the CLI waits for the next human action. | `200` |
