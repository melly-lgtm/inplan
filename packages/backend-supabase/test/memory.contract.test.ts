// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the backend contract against the open core's in-process reference backend.
// This proves the contract suite itself is correct; the Supabase adapter will be
// run against the SAME functions on a local Supabase to prove it is a drop-in.

import { MemoryControlChannel, MemoryDocumentStore } from "@inplan/core";
import { runControlChannelContract, runDocumentStoreContract } from "./contract";

runControlChannelContract("MemoryControlChannel (reference)", () => new MemoryControlChannel());
runDocumentStoreContract("MemoryDocumentStore (reference)", () => new MemoryDocumentStore());
