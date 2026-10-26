/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DEFAULT_CHATS, searchChats } from './chat-search.js';
import { AuthError } from './errors.js';
import type { GraphClient } from './graph-client.js';
import type { SearchFilters } from './kql.js';
import { SCOPES, searchGraph, type SearchResult } from './operations.js';

/** How a search may fall back to the user's chats (design 0007). */
export interface SearchOptions {
  /** Read the chats without trying Graph search first. */
  readonly chatsOnly?: boolean;
  /** How many recent chats a chat scan reads; {@link DEFAULT_CHATS} when omitted. */
  readonly chats?: number;
}

/** Graph refusing search for want of the admin-only scope: the one failure a chat scan answers. */
function refusedForChannelScope(error: unknown): boolean {
  return error instanceof AuthError && error.status === 403 && error.message.includes('ChannelMessage.Read.All');
}

/**
 * Searches the messages the signed-in user can see, through Graph when the tenant has consented
 * to `ChannelMessage.Read.All` and through the user's recent chats otherwise (design 0007). The
 * scope is checked before Graph is asked, because with the broker a missing consent fails at the
 * token, not at Graph; an opaque token that cannot say what it holds is tried against Graph, whose
 * refusal names the scope.
 */
export async function searchMessages(
  graph: GraphClient,
  text: string,
  filters: SearchFilters,
  limit: number,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const chats = options.chats ?? DEFAULT_CHATS;
  if (options.chatsOnly === true) return searchChats(graph, text, filters, { chats, limit, reason: 'asked' });
  if ((await graph.consented(SCOPES.search)) === false) {
    return searchChats(graph, text, filters, { chats, limit, reason: 'consent' });
  }
  try {
    return await searchGraph(graph, text, filters, limit);
  } catch (error) {
    if (!refusedForChannelScope(error)) throw error;
    return searchChats(graph, text, filters, { chats, limit, reason: 'consent' });
  }
}
