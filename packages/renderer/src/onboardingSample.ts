// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The throwaway sample plan the first-run onboarding loads into the editor. It is
// driven by an in-memory api (createMemoryApi), so anything the user does to it —
// commenting, answering, toggling settings — is never written to disk or the cloud.
// It carries one pre-seeded agent question so the "answer the agent" step has a real
// thread to act on. The body text stays simple English; the coach card is localized.

export const ONBOARDING_SAMPLE = `# Sample Plan — Caching Layer

This is a practice document. Nothing you do here is saved.

## Goal

Add a small caching layer so repeated reads don't hit the database every time.

## Open questions

We should pick a [datastore](#cmt-onb001) before wiring anything up.

Select any line above, then press the comment shortcut to leave a note on it.

<!--inplan v1
[
  {
    "id": "cmt-onb001",
    "author": "Agent <agent@inplan>",
    "date": "2026-01-01T00:00:00Z",
    "resolved": false,
    "text": "Which datastore should we use for the cache?",
    "question": {
      "multiSelect": false,
      "choices": [
        { "label": "Redis", "description": "In-memory, fast, has TTLs" },
        { "label": "Postgres", "description": "Already in our stack" },
        { "label": "Memcached", "description": "Simple key/value" }
      ]
    }
  }
]
-->
`;
