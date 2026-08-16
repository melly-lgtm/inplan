// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared accessors for the proposals-v1 store surface, so tests track the surface in one place.

/** The caller-visible pending proposal content (proposals v1 surface). */
export async function proposedContent(store: { myPendingProposal(): Promise<{ content: string } | null> }): Promise<string | null> {
  return (await store.myPendingProposal())?.content ?? null;
}
