<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Keyboard shortcuts

Shortcuts for the inplan editor. The primary modifier is **⌘ on macOS** and
**Ctrl on Windows/Linux** — shown below as `Mod`.

## Global

| Shortcut | Action |
| --- | --- |
| `Mod` + `F` | Open the find bar and focus it (also works while the source editor is focused; re-press to select the query and type over it). |
| `Mod` + `Z` | Undo. While a proposed change is open for review, this steps back through the review's own accept/reject timeline instead of the document history. |
| `Mod` + `Shift` + `Z` | Redo (mirrors undo, including within an open review). |
| `Mod` + `S` | Save — writes canonically in **Instant** mode, or takes a checkpoint backup in **Turn** mode. |
| `Mod` + `/` | Add a comment on the current selection. |
| `Esc` | Dismiss, in order: the open composer → the find bar → the review panel. |

## Comment composer & replies

| Shortcut | Action |
| --- | --- |
| `Mod` + `Enter` | Submit the comment or reply you're typing. |

> On a deactivated (read-only) document the mutating shortcuts — undo/redo, save,
> and add-comment — are disabled, but **find** (`Mod`+`F`) and **Esc** still work
> so the document stays searchable and viewable.
