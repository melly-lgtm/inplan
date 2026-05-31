// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sidecar path resolution is owned by @inplan/core so the CLI and the editor
// always agree on a document's control directory. Re-exported here so existing
// `./paths` imports keep working.
export { docPaths, sidecarRoot, type DocPaths } from "@inplan/core/node";
