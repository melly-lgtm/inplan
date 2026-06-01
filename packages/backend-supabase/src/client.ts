// SPDX-License-Identifier: AGPL-3.0-or-later

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ControlChannel, DocumentStore } from "@inplan/core";
import { SupabaseControlChannel } from "./supabaseControlChannel";
import { SupabaseDocumentStore } from "./supabaseDocumentStore";

/** A control channel + document store bound to one cloud document. */
export interface SupabaseBackend {
  db: SupabaseClient;
  channel: ControlChannel;
  store: DocumentStore;
}

export interface SupabaseBackendOptions {
  url: string;
  /**
   * Anon key for browser/SPA clients (RLS enforced) or the service-role key for
   * the managed agent runtime (bypasses RLS — server-side only, never a browser).
   */
  key: string;
  /** The `documents.id` this backend operates on. */
  docId: string;
  /** Consumer label for the persisted read cursor (e.g. "agent" / "editor"). */
  consumerId?: string;
}

/**
 * Build a Supabase backend for one document. The returned `channel` and `store`
 * are the same `ControlChannel` / `DocumentStore` interfaces the desktop edition
 * consumes, so the CLI and editor run unchanged over the cloud.
 */
export function createSupabaseBackend(opts: SupabaseBackendOptions): SupabaseBackend {
  const db = createClient(opts.url, opts.key);
  return {
    db,
    channel: new SupabaseControlChannel(db, opts.docId, opts.consumerId),
    store: new SupabaseDocumentStore(db, opts.docId),
  };
}
