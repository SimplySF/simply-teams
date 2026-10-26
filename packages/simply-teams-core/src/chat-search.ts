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

/** The scoped terms and operators Teams' KQL documents; anything else in a query is a word to find. */
const KQL_TERM =
  /^(?:from|to|sentto|sent|received|ismentioned|hasattachment|mentions|subject|body|size|importance)\s*[:<>=]/i;
const KQL_OPERATOR = /^(?:AND|OR|NOT|NEAR)$/;

const DAY_MS = 86_400_000;

/** How the chat scan is bounded (design 0007). */
export interface ChatSearchOptions {
  /** How many of the most recent chats to read. */
  readonly chats: number;
  /** The most hits to return. Every chat asked for is read, so the newest hits across them win. */
  readonly limit: number;
  /** Why channels were not searched; shapes the note. */
  readonly reason: 'consent' | 'asked';
  /** The most hits one chat may contribute, so one busy chat cannot crowd out the others (0006 asks for this). */
  readonly hitsPerChat?: number;
}

/** Graph's `sent>=` and `sent<=` are whole UTC days; the scan keeps the same meaning. */
function startOfDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export const DEFAULT_CHATS = 20;
export const MAX_CHATS = 100;
/**
 * How far back one chat is read: two pages of Graph's 50. At the default of 20 chats that is about
 * 40 requests; the scan also stops early once no older chat could hold a newer hit (design 0007).
 */
const PER_CHAT = 100;
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
    if (KQL_OPERATOR.test(token) || KQL_TERM.test(token)) {
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
  if (words.length === 0) return flat.length > SUMMARY_WINDOW ? `${flat.slice(0, SUMMARY_WINDOW)}…` : flat;
  // Longest word first, so "foobar" is one match rather than "foo" inside it; matched on the text
  // itself, case-insensitively, so offsets are never taken from a lower-cased copy of a different length.
  const pattern = new RegExp(
    [...words]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'gi',
  );
  const first = flat.search(pattern);
  const start = Math.max(0, (first === -1 ? 0 : first) - Math.floor(SUMMARY_WINDOW / 3));
  let end = Math.min(flat.length, start + SUMMARY_WINDOW);
  // Not mid-word: a match cut in half would be half bolded.
  while (end < flat.length && flat[end] !== ' ') end += 1;
  let window = flat.slice(start, end);
  window = window.replaceAll(pattern, (match) => `**${match}**`);
  return `${start > 0 ? '…' : ''}${window}${end < flat.length ? '…' : ''}`;
}

/**
 * Whether a sender matches `--from`. Chat messages carry a display name and a user ID, never an
 * address, so an address is matched by the words of its local part: `ada.lovelace@contoso.com`
 * finds "Ada Lovelace".
 */
function senderMatches(message: TeamsMessage, from: string): boolean {
  const name = (message.from?.name ?? '').toLowerCase();
  const wanted = from.trim().toLowerCase();
  if (name.includes(wanted)) return true;
  const at = wanted.indexOf('@');
  if (at <= 0) return false;
  const parts = wanted
    .slice(0, at)
    .split(/[._-]+/)
    .filter((part) => part !== '');
  return parts.length > 0 && parts.every((part) => name.includes(part));
}

function matches(
  message: TeamsMessage,
  words: readonly string[],
  filters: SearchFilters,
  myId: string | undefined,
): boolean {
  if (message.kind === 'event' || message.deleted) return false;
  const haystack = `${message.subject ?? ''}\n${message.text}`.toLowerCase();
  if (!words.every((word) => haystack.includes(word))) return false;
  if (filters.from !== undefined && filters.from.trim() !== '' && !senderMatches(message, filters.from)) return false;
  // Graph's `sent<=` is a whole day; the scan keeps the same meaning.
  if (
    filters.until !== undefined &&
    message.createdAt !== undefined &&
    Date.parse(message.createdAt) >= startOfDay(filters.until) + DAY_MS
  ) {
    return false;
  }
  // By ID, from the message's mentions[]: the text cannot be trusted, since Teams splits a mention
  // into one tag per name part ("@Joe @AbiJaoudi") and people shorten it ("@Joe").
  if (filters.mentionsMe === true) {
    if (myId === undefined || !(message.mentionedUserIds ?? []).includes(myId)) return false;
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

function note(
  options: ChatSearchOptions,
  read: { count: number; all: boolean; stoppedEarly: boolean },
  droppedKql: boolean,
  unreadable: number,
): string {
  const why =
    options.reason === 'consent'
      ? 'Channels were not searched: ChannelMessage.Read.All is not granted to this app.'
      : 'Only chats were searched, as asked.';
  const which = read.all ? `All ${read.count} of your chats` : `The ${read.count} most recent chats`;
  const parts = [`${which} were read instead, up to ${PER_CHAT} messages each`];
  if (read.stoppedEarly) parts.push('older chats were not read, since none could hold a newer match');
  if (unreadable > 0) parts.push(`${unreadable} of them could not be read`);
  if (droppedKql) parts.push('KQL operators in the query were ignored');
  return `${why} ${parts.join('; ')}.`;
}

/**
 * Whether the hits already found are certainly the newest `limit`: there are that many, and the
 * oldest of them is newer than this chat's last message, so nothing in this chat, or in any chat
 * after it, could displace one. A chat with no known last message is always read.
 */
function holdsNewest(hits: readonly TeamsSearchHit[], limit: number, lastActive: string | undefined): boolean {
  if (lastActive === undefined || hits.length < limit) return false;
  const newest = hits.map((hit) => hit.createdAt ?? '').sort((a, b) => b.localeCompare(a));
  const cutoff = newest[limit - 1] ?? '';
  return cutoff !== '' && cutoff > lastActive;
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
  const filtered = [filters.from, filters.since, filters.until, filters.mentionsMe === true || undefined].some(
    (value) => value !== undefined && value !== '',
  );
  if (words.length === 0 && !filtered) {
    throw new ConfigError('A chat scan matches words, not KQL: give words to look for, or a filter flag.');
  }
  const myId = filters.mentionsMe === true ? (await graph.me()).id : undefined;

  const chats = await listChats(graph, options.chats);
  const hits: TeamsSearchHit[] = [];
  let pages = chats.pages;
  let unreadable = 0;
  let read = 0;
  let stoppedEarly = false;

  /* One chat at a time: fanning out would trip Graph's per-app throttling. */
  /* eslint-disable no-await-in-loop */
  for (const chat of chats.items) {
    if (holdsNewest(hits, options.limit, chat.lastMessage?.at)) {
      // Chats come most recently active first, so every chat from here on is older still.
      stoppedEarly = true;
      break;
    }
    read += 1;
    let messages;
    try {
      messages = await listChatMessages(graph, chat.id, {
        since: filters.since === undefined ? undefined : new Date(startOfDay(filters.since)),
        limit: PER_CHAT,
      });
    } catch (error) {
      // A meeting chat the user has left answers 403 (0002): skip it, like everything else does.
      if (error instanceof AuthError && error.status === 403) {
        unreadable += 1;
        continue;
      }
      throw error;
    }
    pages += messages.pages;
    // Newest first within the chat, so a per-chat cap keeps a chat's latest matches.
    const own = [...messages.items].reverse().filter((message) => matches(message, words, filters, myId));
    hits.push(...own.slice(0, options.hitsPerChat ?? own.length).map((message) => hitFrom(message, words)));
  }
  /* eslint-enable no-await-in-loop */

  hits.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // The chat and per-chat bounds are stated in the note; `complete` answers only whether `limit` cut hits.
  return {
    query,
    items: hits.slice(0, options.limit),
    pages,
    complete: hits.length <= options.limit,
    scope: 'chats',
    note: note(options, { count: read, all: chats.complete && !stoppedEarly, stoppedEarly }, droppedKql, unreadable),
  };
}
