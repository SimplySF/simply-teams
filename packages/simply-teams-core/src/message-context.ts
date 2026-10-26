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

import { AuthError, ConfigError, HttpError } from './errors.js';
import type { GraphClient } from './graph-client.js';
import type { SearchFilters } from './kql.js';
import {
  type ChannelLocation,
  type GraphChat,
  normalizeChat,
  type TeamsMessage,
  type TeamsSearchHit,
} from './messages.js';
import {
  listChannels,
  listTeams,
  MAX_CONTEXT,
  SCOPES,
  searchMessages,
  type SearchOptions,
  viewMessage,
} from './operations.js';
import { parseRef, type TeamsRef } from './refs.js';

/** How a context call is bounded (design 0006). */
export interface ContextOptions {
  /** How many threads to return, in relevance order. */
  readonly threads: number;
  /** Messages around each hit: a channel thread's replies, a chat's messages either side. */
  readonly context: number;
  /** A ceiling on the characters of message text returned. */
  readonly maxChars: number;
  /** How the search may fall back to the user's chats (design 0007). */
  readonly search?: SearchOptions;
}

export const MAX_THREADS = 20;
export const DEFAULT_THREADS = 5;
export const DEFAULT_CONTEXT = 10;
export const DEFAULT_MAX_CHARS = 24_000;

export interface ContextThread {
  /** A ref `message view` accepts: the thread's first hit. */
  readonly ref: string;
  readonly kind: 'channel' | 'chat';
  /** "Team / Channel", or a chat's topic or type, when it could be named. */
  readonly where?: string;
  readonly chatId?: string;
  readonly channel?: ChannelLocation;
  /** Matching messages in this thread. */
  readonly hits: number;
  /** Which messages matched, so a renderer can mark them. */
  readonly hitIds: readonly string[];
  /** Oldest first, in 0002's shape. */
  readonly messages: readonly TeamsMessage[];
  /** Messages were dropped from this thread to fit the budget. */
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly webUrl?: string;
}

export interface MessageContext {
  /** The KQL sent. */
  readonly query: string;
  /** Hits the search returned. */
  readonly searched: number;
  /** False when more hits were available than were read. */
  readonly searchComplete: boolean;
  /** `all` when Graph searched chats and channels; `chats` when only the user's chats were read (0007). */
  readonly scope: 'all' | 'chats';
  /** For a chat scan: what was and was not searched. */
  readonly note?: string;
  /** In relevance order of their first hit. */
  readonly threads: readonly ContextThread[];
  /** Threads beyond `threads`, or that could not be read. */
  readonly skipped: number;
  /** The budget cut something. */
  readonly truncated: boolean;
}

/** Less room than this fits no message worth returning, so reading stops there. */
const MIN_ROOM = 64;

/** Hits are read five per thread wanted, so a thread with several hits still leaves room for others. */
const HITS_PER_THREAD = 5;
const MAX_HITS = 50;

interface Group {
  readonly key: string;
  readonly first: TeamsSearchHit;
  readonly ref: Extract<TeamsRef, { kind: 'chatMessage' | 'channelMessage' }>;
  readonly ids: string[];
}

/** The thread a hit belongs to: a channel root post, or the chat itself. */
function threadKey(ref: Extract<TeamsRef, { kind: 'chatMessage' | 'channelMessage' }>): string {
  return ref.kind === 'chatMessage'
    ? `chat:${ref.chatId}`
    : `channel:${ref.teamId}/${ref.channelId}/${ref.rootId ?? ref.messageId}`;
}

/** Groups hits by thread, in the order their first hit came back; hits with no readable ref are counted. */
function groupHits(hits: readonly TeamsSearchHit[]): { groups: Group[]; unreadable: number } {
  const groups = new Map<string, Group>();
  let unreadable = 0;
  for (const hit of hits) {
    let ref: Extract<TeamsRef, { kind: 'chatMessage' | 'channelMessage' }>;
    try {
      ref = parseRef(hit.ref, ['chatMessage', 'channelMessage']);
    } catch {
      unreadable += 1; // Search's own output still lists it; it cannot be read as a thread.
      continue;
    }
    const key = threadKey(ref);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, first: hit, ref, ids: [hit.id] });
    else group.ids.push(hit.id);
  }
  return { groups: [...groups.values()], unreadable };
}

/** Names teams, channels and chats once per run; a failed lookup names nothing rather than failing the call. */
class Namer {
  private teams: Promise<Map<string, string>> | undefined;
  private readonly channels = new Map<string, Promise<Map<string, string>>>();
  private readonly chats = new Map<string, Promise<string | undefined>>();

  public constructor(private readonly graph: GraphClient) {}

  public async channel(location: ChannelLocation): Promise<string | undefined> {
    const teamName = (await this.teamNames()).get(location.teamId);
    const channelName = (await this.channelNames(location.teamId)).get(location.channelId);
    if (teamName === undefined && channelName === undefined) return undefined;
    return `${teamName ?? location.teamId} / ${channelName ?? location.channelId}`;
  }

  public chat(chatId: string): Promise<string | undefined> {
    let named = this.chats.get(chatId);
    if (named === undefined) {
      named = this.graph
        .get<GraphChat>(`/chats/${encodeURIComponent(chatId)}`, SCOPES.chats, { $select: ['id', 'topic', 'chatType'] })
        .then((raw) => {
          // The same labelling the chat list uses, including its fix for Graph's meeting-chat placeholder.
          const chat = normalizeChat(raw);
          const label = chat.topic ?? chat.type;
          return label === undefined ? undefined : `${label} chat`;
        })
        .catch(() => undefined);
      this.chats.set(chatId, named);
    }
    return named;
  }

  private teamNames(): Promise<Map<string, string>> {
    this.teams ??= listTeams(this.graph, 1000)
      .then((teams) => new Map(teams.items.map((team) => [team.id, team.name ?? team.id])))
      .catch(() => new Map<string, string>());
    return this.teams;
  }

  private channelNames(teamId: string): Promise<Map<string, string>> {
    let names = this.channels.get(teamId);
    if (names === undefined) {
      names = listChannels(this.graph, { id: teamId })
        .then((channels) => new Map(channels.items.map((channel) => [channel.id, channel.name ?? channel.id])))
        .catch(() => new Map<string, string>());
      this.channels.set(teamId, names);
    }
    return names;
  }
}

function size(message: TeamsMessage): number {
  return message.text.length + (message.subject?.length ?? 0) + (message.from?.name?.length ?? 0) + 32;
}

/**
 * Drops messages from the ends furthest from the hits until the thread fits in `room`. Returns
 * the kept messages, or nothing when even the hits alone do not fit.
 */
function trimToFit(
  messages: readonly TeamsMessage[],
  hitIds: ReadonlySet<string>,
  room: number,
): { kept: TeamsMessage[]; truncated: boolean } | undefined {
  const kept = [...messages];
  let total = kept.reduce((sum, message) => sum + size(message), 0);
  let truncated = false;
  while (total > room && kept.length > 0) {
    const first = kept[0];
    const last = kept.at(-1);
    const firstIsHit = first !== undefined && hitIds.has(first.id);
    const lastIsHit = last !== undefined && hitIds.has(last.id);
    let dropped: TeamsMessage | undefined;
    if (!lastIsHit) dropped = kept.pop();
    else if (!firstIsHit) dropped = kept.shift();
    else return undefined;
    if (dropped !== undefined) total -= size(dropped);
    truncated = true;
  }
  // A thread whose hits were not in the window that was read trims down to nothing: skip it.
  if (kept.length === 0) return undefined;
  return { kept, truncated };
}

/**
 * The threads behind a question, in one call (design 0006): search, group the hits into threads,
 * read each thread around its hit, and return them in relevance order within a budget. Threads are
 * read one at a time, because Graph throttles chat and channel reads per app and tenant.
 */
function checkOptions(options: ContextOptions): void {
  if (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > MAX_THREADS) {
    throw new ConfigError(`Threads must be a whole number from 1 to ${MAX_THREADS}.`);
  }
  if (!Number.isInteger(options.context) || options.context < 0 || options.context > MAX_CONTEXT) {
    throw new ConfigError(`Context must be a whole number from 0 to ${MAX_CONTEXT}.`);
  }
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    throw new ConfigError('The character budget must be a positive whole number.');
  }
}

/** Reads one thread, or nothing when it cannot be read: a meeting chat the user has left (403), a message deleted since it was indexed (404). */
async function readThread(
  graph: GraphClient,
  group: Group,
  context: number,
): Promise<{ messages: TeamsMessage[]; warnings: readonly string[] } | undefined> {
  try {
    const view = await viewMessage(graph, group.ref, context);
    return { messages: view.thread.length === 0 ? [view.message] : [...view.thread], warnings: view.warnings };
  } catch (error) {
    if ((error instanceof AuthError && error.status === 403) || error instanceof HttpError) return undefined;
    throw error;
  }
}

function describeGroup(group: Group, namer: Namer): Promise<string | undefined> {
  return group.ref.kind === 'chatMessage'
    ? namer.chat(group.ref.chatId)
    : namer.channel({ teamId: group.ref.teamId, channelId: group.ref.channelId });
}

export async function gatherMessageContext(
  graph: GraphClient,
  text: string,
  filters: SearchFilters,
  options: ContextOptions,
): Promise<MessageContext> {
  checkOptions(options);

  const search = await searchMessages(
    graph,
    text,
    filters,
    Math.min(MAX_HITS, options.threads * HITS_PER_THREAD),
    options.search,
  );
  const { groups, unreadable } = groupHits(search.items);
  const namer = new Namer(graph);
  const threads: ContextThread[] = [];
  const wanted = groups.slice(0, options.threads);
  let skipped = unreadable + (groups.length - wanted.length);
  let used = 0;
  let truncated = false;

  /* One thread at a time: fanning out would trip Graph's per-app throttling on a busy tenant. */
  /* eslint-disable no-await-in-loop */
  for (const [index, group] of wanted.entries()) {
    if (options.maxChars - used < MIN_ROOM) {
      // Nothing more fits, so nothing more is read.
      skipped += wanted.length - index;
      truncated = true;
      break;
    }
    const view = await readThread(graph, group, options.context);
    if (view === undefined) {
      // One unreadable thread must not cost the agent every other thread.
      skipped += 1;
      continue;
    }
    const hitIds = new Set(group.ids);
    const fit = trimToFit(view.messages, hitIds, options.maxChars - used);
    if (fit === undefined) {
      skipped += 1;
      truncated = true;
      continue;
    }
    used += fit.kept.reduce((sum, message) => sum + size(message), 0);
    truncated = truncated || fit.truncated;
    threads.push({
      ref: group.first.ref,
      kind: group.ref.kind === 'chatMessage' ? 'chat' : 'channel',
      where: await describeGroup(group, namer),
      chatId: group.ref.kind === 'chatMessage' ? group.ref.chatId : undefined,
      channel:
        group.ref.kind === 'channelMessage' ? { teamId: group.ref.teamId, channelId: group.ref.channelId } : undefined,
      hits: group.ids.length,
      hitIds: group.ids,
      messages: fit.kept,
      truncated: fit.truncated,
      warnings: view.warnings,
      webUrl: group.first.webUrl,
    });
  }
  /* eslint-enable no-await-in-loop */

  return {
    query: search.query,
    searched: search.items.length,
    searchComplete: search.complete,
    scope: search.scope,
    note: search.note,
    threads,
    skipped,
    truncated,
  };
}
