# inplan

A commented span is an inline Markdown link whose href is the comment id; the
comments themselves live in a single trailing HTML-comment block (one JSON array):

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

## License

inplan is **dual-licensed**:

- **Open source:** [AGPL-3.0-or-later](./LICENSE).
- **Commercial:** a separate license from CrazyIdeaStudio, Inc. for
  proprietary or SaaS use without the AGPL's copyleft — see
  [`LICENSING.md`](./LICENSING.md), contact **licensing@crazyideastudio.com**.

Contributions require signing the [CLA](./CLA.md). See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
