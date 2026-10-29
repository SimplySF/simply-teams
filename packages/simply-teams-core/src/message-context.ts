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
import { listChannels, listTeams, MAX_CONTEXT, SCOPES, viewMessage } from './operations.js';
import { searchMessages, type SearchOptions } from './search.js';
import { parseRef, type TeamsRef } from './refs.js';
import { ThreadRoots } from './thread-root.js';

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
  /** Matching messages among `messages`. A hit outside the window that was read is not counted. */
  readonly hits: number;
  /** Which of `messages` matched, so a renderer can mark them. */
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
  /** Threads beyond `threads`, or that could not be read or fitted. Counts threads, never hits. */
  readonly skipped: number;
  /** Hits whose ref names no message, so they belong to no thread. Counts hits. */
  readonly unplaced: number;
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

/**
 * Groups hits by thread, in the order their first hit came back; hits with no readable ref are
 * counted. A channel hit whose ref names only the message is placed first: when the hit is a reply,
 * its thread is the root's, and two replies to one post must make one thread, not two. The lookup
 * reads the channel's newest posts once per channel (see {@link ThreadRoots}); a message it does not
 * find keeps its own ID as the key, and reading it then says whether it is a root or gone.
 */
async function groupHits(
  hits: readonly TeamsSearchHit[],
  roots: ThreadRoots,
): Promise<{ groups: Group[]; unreadable: number }> {
  const groups = new Map<string, Group>();
  let unreadable = 0;
  /* One lookup at a time: each may read a page, and they share what was read. */
  /* eslint-disable no-await-in-loop */
  for (const hit of hits) {
    let ref: Extract<TeamsRef, { kind: 'chatMessage' | 'channelMessage' }>;
    try {
      ref = parseRef(hit.ref, ['chatMessage', 'channelMessage']);
    } catch {
      unreadable += 1; // Search's own output still lists it; it cannot be read as a thread.
      continue;
    }
    if (ref.kind === 'channelMessage' && ref.rootId === undefined) {
      const rootId = await roots.rootOf(ref.teamId, ref.channelId, ref.messageId);
      if (rootId !== undefined && rootId !== ref.messageId) ref = { ...ref, rootId };
    }
    const key = threadKey(ref);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, first: hit, ref, ids: [hit.id] });
    else group.ids.push(hit.id);
  }
  /* eslint-enable no-await-in-loop */
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

/** How far each message is from the nearest hit, by position; `Infinity` when there is no hit. */
function distances(messages: readonly TeamsMessage[], hitIds: ReadonlySet<string>): number[] {
  const hits = messages.flatMap((message, index) => (hitIds.has(message.id) ? [index] : []));
  return messages.map((_, index) => Math.min(...hits.map((hit) => Math.abs(hit - index))));
}

/**
 * Drops the message furthest from any hit, one at a time, until the thread fits in `room`; ties go
 * to the later message, which is the one further from a channel's root post. Hits are never
 * dropped, so a thread with hits at both ends loses its middle rather than being skipped. Returns
 * nothing when the hits alone do not fit, or when no hit was in the window that was read.
 */
function trimToFit(
  messages: readonly TeamsMessage[],
  hitIds: ReadonlySet<string>,
  room: number,
): { kept: TeamsMessage[]; truncated: boolean } | undefined {
  if (!messages.some((message) => hitIds.has(message.id))) return undefined;
  const kept = [...messages];
  let total = kept.reduce((sum, message) => sum + size(message), 0);
  let truncated = false;
  while (total > room) {
    const away = distances(kept, hitIds);
    const furthest = Math.max(...away);
    if (furthest === 0) return undefined; // Only hits are left, and they do not fit.
    const index = away.lastIndexOf(furthest);
    const [dropped] = kept.splice(index, 1);
    if (dropped !== undefined) total -= size(dropped);
    truncated = true;
  }
  return { kept, truncated };
}

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

/**
 * Reads one thread, or nothing when it cannot be read: a meeting chat the user has left (403), a
 * message deleted since it was indexed (404). Anything else, throttling and server errors that
 * outlasted the retries included, fails the call: skipping those would hide a struggling tenant
 * behind "more threads not shown" while the loop kept sending it requests.
 */
async function readThread(
  graph: GraphClient,
  group: Group,
  context: number,
  roots: ThreadRoots,
): Promise<{ messages: TeamsMessage[]; warnings: readonly string[] } | undefined> {
  try {
    const view = await viewMessage(graph, group.ref, context, roots);
    return { messages: view.thread.length === 0 ? [view.message] : [...view.thread], warnings: view.warnings };
  } catch (error) {
    if ((error instanceof AuthError && error.status === 403) || (error instanceof HttpError && error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}

function describeGroup(group: Group, namer: Namer): Promise<string | undefined> {
  return group.ref.kind === 'chatMessage'
    ? namer.chat(group.ref.chatId)
    : namer.channel({ teamId: group.ref.teamId, channelId: group.ref.channelId });
}

/**
 * The threads behind a question, in one call (design 0006): search, group the hits into threads,
 * read each thread around its hit, and return them in relevance order within a budget. Threads are
 * read one at a time, because Graph throttles chat and channel reads per app and tenant.
 */
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
    // Under the chat fallback, cap each chat's hits so one busy chat cannot crowd the others out.
    { ...options.search, hitsPerChat: HITS_PER_THREAD },
  );
  const roots = new ThreadRoots(graph);
  const { groups, unreadable } = await groupHits(search.items, roots);
  const namer = new Namer(graph);
  const threads: ContextThread[] = [];
  const wanted = groups.slice(0, options.threads);
  let skipped = groups.length - wanted.length;
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
    const view = await readThread(graph, group, options.context, roots);
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
    // Only the hits that are shown: a later hit in a chat can fall outside the window around the first.
    const shown = new Set(fit.kept.map((message) => message.id));
    const shownHits = group.ids.filter((id) => shown.has(id));
    truncated = truncated || fit.truncated;
    threads.push({
      ref: group.first.ref,
      kind: group.ref.kind === 'chatMessage' ? 'chat' : 'channel',
      where: await describeGroup(group, namer),
      chatId: group.ref.kind === 'chatMessage' ? group.ref.chatId : undefined,
      channel:
        group.ref.kind === 'channelMessage' ? { teamId: group.ref.teamId, channelId: group.ref.channelId } : undefined,
      hits: shownHits.length,
      hitIds: shownHits,
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
    unplaced: unreadable,
    truncated,
  };
}
