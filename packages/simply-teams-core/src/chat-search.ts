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

import { AuthError, ConfigError } from './errors.js';
import type { GraphClient } from './graph-client.js';
import { buildSearchQuery, type SearchFilters } from './kql.js';
import type { TeamsMessage, TeamsSearchHit } from './messages.js';
import { listChatMessages, listChats, type SearchResult } from './operations.js';

/** How the chat scan is bounded (design 0007). */
export interface ChatSearchOptions {
  /** How many of the most recent chats to read. */
  readonly chats: number;
  /** Stop once this many hits are found. */
  readonly limit: number;
  /** Why channels were not searched; shapes the note. */
  readonly reason: 'consent' | 'asked';
}

export const DEFAULT_CHATS = 20;
export const MAX_CHATS = 100;
/** One page of a chat, the most Graph returns per request times the pages one chat is worth here. */
const PER_CHAT = 200;
/** How much of a message is shown around its first match. */
const SUMMARY_WINDOW = 160;

/**
 * The words to look for. KQL has no meaning here: a scoped term (`from:x`, `sent>=…`) or an
 * operator would otherwise be matched as text and find nothing, so they are dropped, and the
 * note says so.
 */
export function searchWords(text: string): { words: string[]; droppedKql: boolean } {
  const words: string[] = [];
  let droppedKql = false;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replaceAll('"', '').trim();
    if (token === '') continue;
    if (/^(?:AND|OR|NOT)$/.test(token) || /^[\w.-]+[:<>=]/.test(token)) {
      droppedKql = true;
      continue;
    }
    words.push(token.toLowerCase());
  }
  return { words, droppedKql };
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** A window of the text around its first match, with every match in bold, as Graph's summaries are. */
export function summarize(text: string, words: readonly string[]): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const first =
    words
      .map((word) => lower.indexOf(word))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - Math.floor(SUMMARY_WINDOW / 3));
  const end = Math.min(flat.length, start + SUMMARY_WINDOW);
  let window = flat.slice(start, end);
  if (words.length > 0) {
    const pattern = new RegExp(words.map(escapeRegExp).join('|'), 'gi');
    window = window.replaceAll(pattern, (match) => `**${match}**`);
  }
  return `${start > 0 ? '…' : ''}${window}${end < flat.length ? '…' : ''}`;
}

function matches(
  message: TeamsMessage,
  words: readonly string[],
  filters: SearchFilters,
  myName: string | undefined,
): boolean {
  if (message.kind === 'event' || message.deleted) return false;
  const haystack = `${message.subject ?? ''}\n${message.text}`.toLowerCase();
  if (!words.every((word) => haystack.includes(word))) return false;
  if (filters.from !== undefined && filters.from.trim() !== '') {
    const wanted = filters.from.trim().toLowerCase();
    const sender = `${message.from?.name ?? ''} ${message.from?.email ?? ''}`.toLowerCase();
    if (!sender.includes(wanted)) return false;
  }
  if (
    filters.until !== undefined &&
    message.createdAt !== undefined &&
    Date.parse(message.createdAt) > filters.until.getTime()
  ) {
    return false;
  }
  if (filters.mentionsMe === true) {
    if (myName === undefined || !haystack.includes(`@${myName.toLowerCase()}`)) return false;
  }
  return true;
}

function hitFrom(message: TeamsMessage, words: readonly string[]): TeamsSearchHit {
  return {
    ref: message.ref,
    id: message.id,
    chatId: message.chatId,
    channel: message.channel,
    from: message.from,
    createdAt: message.createdAt,
    summary: summarize(message.text, words),
    webUrl: message.webUrl,
  };
}

function note(options: ChatSearchOptions, droppedKql: boolean): string {
  const why =
    options.reason === 'consent'
      ? 'Channels were not searched: ChannelMessage.Read.All is not granted to this app.'
      : 'Only chats were searched, as asked.';
  const kql = droppedKql ? '; KQL operators in the query were ignored' : '';
  return `${why} The ${options.chats} most recent chats were read instead, up to ${PER_CHAT} messages each${kql}.`;
}

/**
 * Searches the user's recent chats on the client, with the scope a user can grant for
 * themselves (design 0007). Every word must appear; hits come newest first, since there is no
 * relevance to rank by; the result says what was and was not searched.
 */
export async function searchChats(
  graph: GraphClient,
  text: string,
  filters: SearchFilters,
  options: ChatSearchOptions,
): Promise<SearchResult> {
  if (!Number.isInteger(options.chats) || options.chats < 1 || options.chats > MAX_CHATS) {
    throw new ConfigError(`Chats must be a whole number from 1 to ${MAX_CHATS}.`);
  }
  // Validates the query the same way search does: words, or at least one filter.
  const query = buildSearchQuery(text, filters);
  const { words, droppedKql } = searchWords(text);
  const myName = filters.mentionsMe === true ? (await graph.me()).displayName : undefined;

  const chats = await listChats(graph, options.chats);
  const hits: TeamsSearchHit[] = [];
  let pages = chats.pages;
  let complete = chats.complete;

  /* One chat at a time: fanning out would trip Graph's per-app throttling. */
  /* eslint-disable no-await-in-loop */
  for (const chat of chats.items) {
    let messages;
    try {
      messages = await listChatMessages(graph, chat.id, { since: filters.since, limit: PER_CHAT });
    } catch (error) {
      // A meeting chat the user has left answers 403 (0002): skip it, like everything else does.
      if (error instanceof AuthError && error.status === 403) continue;
      throw error;
    }
    pages += messages.pages;
    if (!messages.complete) complete = false;
    for (const message of messages.items) {
      if (matches(message, words, filters, myName)) hits.push(hitFrom(message, words));
    }
  }
  /* eslint-enable no-await-in-loop */

  hits.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  if (hits.length > options.limit) complete = false;
  return {
    query,
    items: hits.slice(0, options.limit),
    pages,
    complete,
    scope: 'chats',
    note: note(options, droppedKql),
  };
}
