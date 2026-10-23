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
import type { GraphClient, ListResult } from './graph-client.js';
import { buildSearchQuery, type SearchFilters } from './kql.js';
import {
  type GraphChat,
  type GraphChatMessage,
  type GraphSearchHit,
  normalizeChat,
  normalizeMessage,
  normalizeSearchHit,
  type TeamsChat,
  type TeamsMessage,
  type TeamsSearchHit,
} from './messages.js';
import {
  buildMessageBody,
  type MentionTarget,
  type MessageBody,
  type MessageInput,
  validateMessageInput,
} from './message-body.js';
import type { Selector, TeamsRef } from './refs.js';
import { stripControlOneLine } from './text.js';

/** The scopes each kind of read needs (design 0002, Commands). Each call asks for exactly these. */
export const SCOPES = {
  search: ['Chat.Read', 'ChannelMessage.Read.All'],
  chats: ['Chat.Read'],
  teams: ['Team.ReadBasic.All'],
  channels: ['Channel.ReadBasic.All'],
  channelMessages: ['ChannelMessage.Read.All'],
  users: ['User.ReadBasic.All'],
  channelSend: ['ChannelMessage.Send'],
  chatSend: ['ChatMessage.Send'],
} as const;

/** Graph's documented example page size for message search; the true maximum is unverified (0002). */
const SEARCH_PAGE_SIZE = 25;
const MAX_SEARCH_PAGES = 40;
/** Graph's ceiling on `$top` for chat and channel messages. */
const MESSAGE_PAGE_SIZE = 50;
/** How far `message view --context` will walk back through a chat looking for the message: ~500 messages. */
const CONTEXT_SCAN_PAGES = 10;
/** The most `--context` may ask for on each side. */
export const MAX_CONTEXT = 50;

const encode = encodeURIComponent;

// --- Search ---

export interface SearchResult extends ListResult<TeamsSearchHit> {
  /** The KQL actually sent, so a caller can see how its flags were read. */
  readonly query: string;
}

interface SearchResponse {
  readonly value?: ReadonlyArray<{
    readonly hitsContainers?: ReadonlyArray<{
      readonly hits?: readonly GraphSearchHit[];
      readonly moreResultsAvailable?: boolean;
    }>;
  }>;
}

/**
 * Searches the messages the signed-in user can see. Graph cannot sort message hits and its
 * `total` counts only the current page (both documented), so neither is offered: results come in
 * Graph's relevance order, and completeness is reported from `moreResultsAvailable`.
 */
export async function searchMessages(
  graph: GraphClient,
  text: string,
  filters: SearchFilters,
  limit: number,
): Promise<SearchResult> {
  const query = buildSearchQuery(text, filters);
  const items: TeamsSearchHit[] = [];
  let from = 0;
  let pages = 0;
  let more = true;

  /* Each page starts where the previous one ended, so the requests cannot overlap. */
  /* eslint-disable no-await-in-loop */
  while (more && items.length < limit && pages < MAX_SEARCH_PAGES) {
    const response = await graph.post<SearchResponse>(
      '/search/query',
      { requests: [{ entityTypes: ['chatMessage'], query: { queryString: query }, from, size: SEARCH_PAGE_SIZE }] },
      SCOPES.search,
    );
    pages += 1;
    const container = response.value?.[0]?.hitsContainers?.[0];
    const hits = container?.hits ?? [];
    items.push(...hits.map(normalizeSearchHit));
    more = container?.moreResultsAvailable === true && hits.length > 0;
    from += hits.length;
  }
  /* eslint-enable no-await-in-loop */

  return { query, items: items.slice(0, limit), pages, complete: !more && items.length <= limit };
}

// --- One message, with its surroundings ---

export interface MessageView {
  readonly message: TeamsMessage;
  /**
   * The message in its conversation, oldest first, including the message itself. For a channel
   * message that is the root post and its replies; for a chat message, the messages either side.
   * Empty when no context was asked for.
   */
  readonly thread: readonly TeamsMessage[];
  readonly warnings: readonly string[];
}

/**
 * A 403 reading a chat the user can list is almost always a meeting chat they have since left:
 * Graph lists it but will not hand over its messages. Saying so beats a bare "forbidden".
 */
async function chatRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AuthError && error.status === 403 && /InsufficientPrivileges/i.test(error.message)) {
      throw new AuthError(
        `${error.message} You can see this chat but not read it, which usually means a meeting chat you are no longer part of.`,
        403,
      );
    }
    throw error;
  }
}

function chronological(messages: readonly TeamsMessage[]): TeamsMessage[] {
  return [...messages].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

async function chatContext(
  graph: GraphClient,
  chatId: string,
  messageId: string,
  context: number,
): Promise<{ thread: TeamsMessage[]; warnings: string[] }> {
  // Graph has no "messages around X", so walk back from the newest until the message is passed
  // and `context` older ones are in hand, within a fixed bound.
  const newestFirst: GraphChatMessage[] = [];
  let found = -1;
  for await (const page of graph.pages<GraphChatMessage>(`/chats/${encode(chatId)}/messages`, {
    scopes: SCOPES.chats,
    query: { $top: MESSAGE_PAGE_SIZE },
    maxPages: CONTEXT_SCAN_PAGES,
  })) {
    newestFirst.push(...page.items);
    if (found === -1) found = newestFirst.findIndex((message) => message.id === messageId);
    if (found !== -1 && newestFirst.length > found + context) break;
  }
  if (found === -1) {
    return {
      thread: [],
      warnings: [
        `The message is older than the ${CONTEXT_SCAN_PAGES * MESSAGE_PAGE_SIZE} most recent in this chat, so no context was gathered.`,
      ],
    };
  }
  const window = newestFirst.slice(Math.max(0, found - context), found + context + 1).map(normalizeMessage);
  return { thread: chronological(window), warnings: [] };
}

async function channelContext(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'channelMessage' }>,
  context: number,
): Promise<{ thread: TeamsMessage[]; warnings: string[] }> {
  const base = `/teams/${encode(ref.teamId)}/channels/${encode(ref.channelId)}/messages`;
  const rootId = ref.rootId ?? ref.messageId;
  const [root, replies] = await Promise.all([
    graph.get<GraphChatMessage>(`${base}/${encode(rootId)}`, SCOPES.channelMessages),
    graph.list<GraphChatMessage>(`${base}/${encode(rootId)}/replies`, {
      scopes: SCOPES.channelMessages,
      query: { $top: MESSAGE_PAGE_SIZE },
      limit: CONTEXT_SCAN_PAGES * MESSAGE_PAGE_SIZE,
      maxPages: CONTEXT_SCAN_PAGES,
    }),
  ]);
  const ordered = chronological(replies.items.map(normalizeMessage));
  const at = ordered.findIndex((message) => message.id === ref.messageId);
  // On the root post, the "context" is its first replies; on a reply, the replies either side.
  const window = at === -1 ? ordered.slice(0, context) : ordered.slice(Math.max(0, at - context), at + context + 1);
  const warnings = replies.complete
    ? []
    : [`The thread has more than ${replies.items.length} replies; only those were read.`];
  return { thread: [normalizeMessage(root), ...window], warnings };
}

export async function viewMessage(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'chatMessage' | 'channelMessage' }>,
  context = 0,
): Promise<MessageView> {
  if (!Number.isInteger(context) || context < 0 || context > MAX_CONTEXT) {
    throw new ConfigError(`Context must be a whole number from 0 to ${MAX_CONTEXT}.`);
  }
  if (ref.kind === 'chatMessage') {
    const raw = await chatRead(() =>
      graph.get<GraphChatMessage>(`/chats/${encode(ref.chatId)}/messages/${encode(ref.messageId)}`, SCOPES.chats),
    );
    const around =
      context === 0 ? { thread: [], warnings: [] } : await chatContext(graph, ref.chatId, ref.messageId, context);
    return { message: normalizeMessage(raw), ...around };
  }

  const base = `/teams/${encode(ref.teamId)}/channels/${encode(ref.channelId)}/messages`;
  const path =
    ref.rootId === undefined
      ? `${base}/${encode(ref.messageId)}`
      : `${base}/${encode(ref.rootId)}/replies/${encode(ref.messageId)}`;
  const raw = await graph.get<GraphChatMessage>(path, SCOPES.channelMessages);
  const around = context === 0 ? { thread: [], warnings: [] } : await channelContext(graph, ref, context);
  return { message: normalizeMessage(raw), ...around };
}

// --- Chats ---

export async function listChats(graph: GraphClient, limit: number): Promise<ListResult<TeamsChat>> {
  const result = await graph.list<GraphChat>('/me/chats', {
    scopes: SCOPES.chats,
    limit,
    // Most recently active first, which is the order a person scans their chat list in.
    query: {
      $top: Math.min(limit, 50),
      $expand: 'lastMessagePreview',
      $orderby: 'lastMessagePreview/createdDateTime desc',
    },
  });
  return { ...result, items: result.items.map(normalizeChat) };
}

export interface MessageListOptions {
  /** Only messages created at or after this. */
  readonly since?: Date;
  readonly limit: number;
  /** Keep system events (calls, membership changes); dropped by default as noise. */
  readonly includeEvents?: boolean;
}

/**
 * Recent messages in a chat, returned oldest first so they read as a transcript. Graph serves
 * them newest first, which is what lets `since` stop paging at the cutoff instead of fetching a
 * whole history to filter.
 */
export async function listChatMessages(
  graph: GraphClient,
  chatId: string,
  options: MessageListOptions,
): Promise<ListResult<TeamsMessage>> {
  const kept: TeamsMessage[] = [];
  let pages = 0;
  let complete = true;
  const cutoff = options.since?.getTime();

  await chatRead(async () => {
    for await (const page of graph.pages<GraphChatMessage>(`/chats/${encode(chatId)}/messages`, {
      scopes: SCOPES.chats,
      query: { $top: MESSAGE_PAGE_SIZE },
    })) {
      pages += 1;
      complete = !page.hasMore;
      for (const raw of page.items) {
        if (cutoff !== undefined && raw.createdDateTime !== undefined && Date.parse(raw.createdDateTime) < cutoff) {
          return; // Everything after this is older still.
        }
        const message = normalizeMessage(raw);
        if (message.kind === 'event' && options.includeEvents !== true) continue;
        if (kept.length >= options.limit) {
          complete = false;
          return;
        }
        kept.push(message);
      }
    }
  });

  // Any return before the pages ran out was a cutoff, which is a complete answer to the question asked.
  if (cutoff !== undefined && kept.length < options.limit) complete = true;
  return { items: kept.reverse(), pages, complete };
}

// --- Teams and channels ---

export interface TeamsTeam {
  readonly ref: string;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

export interface TeamsChannel {
  readonly ref: string;
  readonly id: string;
  readonly teamId: string;
  readonly name?: string;
  readonly membershipType?: string;
  readonly webUrl?: string;
}

interface GraphNamed {
  readonly id: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly membershipType?: string;
  readonly webUrl?: string | null;
}

function clean(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : stripControlOneLine(value);
}

export async function listTeams(graph: GraphClient, limit: number): Promise<ListResult<TeamsTeam>> {
  const result = await graph.list<GraphNamed>('/me/joinedTeams', { scopes: SCOPES.teams, limit });
  return {
    ...result,
    items: result.items.map((team) => ({
      ref: team.id,
      id: team.id,
      name: clean(team.displayName),
      description: clean(team.description),
    })),
  };
}

/** Finds one item by display name, case-insensitively; none or several is a `ConfigError`. */
function byName<T extends { readonly name?: string; readonly id: string }>(
  items: readonly T[],
  name: string,
  what: string,
): T {
  const wanted = name.trim().toLowerCase();
  const matches = items.filter((item) => item.name?.toLowerCase() === wanted);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new ConfigError(`No ${what} you belong to is named "${name}".`);
  throw new ConfigError(
    `${matches.length} ${what}s are named "${name}"; use the ID instead (${matches.map((m) => m.id).join(', ')}).`,
  );
}

export async function resolveTeamId(graph: GraphClient, team: Selector): Promise<string> {
  if ('id' in team) return team.id;
  const teams = await listTeams(graph, 1000);
  return byName(teams.items, team.name, 'team').id;
}

export async function listChannels(graph: GraphClient, team: Selector): Promise<ListResult<TeamsChannel>> {
  const teamId = await resolveTeamId(graph, team);
  const result = await graph.list<GraphNamed>(`/teams/${encode(teamId)}/channels`, {
    scopes: SCOPES.channels,
    limit: 1000,
  });
  return {
    ...result,
    items: result.items.map((channel) => ({
      ref: `${teamId}/${channel.id}`,
      id: channel.id,
      teamId,
      name: clean(channel.displayName),
      membershipType: channel.membershipType,
      webUrl: channel.webUrl ?? undefined,
    })),
  };
}

export async function resolveChannel(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'channel' }>,
): Promise<{ teamId: string; channelId: string }> {
  const teamId = await resolveTeamId(graph, ref.team);
  if ('id' in ref.channel) return { teamId, channelId: ref.channel.id };
  const channels = await listChannels(graph, { id: teamId });
  return { teamId, channelId: byName(channels.items, ref.channel.name, 'channel').id };
}

export interface ChannelMessageOptions extends MessageListOptions {
  /** Also fetch each post's replies, one request per post. */
  readonly replies?: boolean;
}

/**
 * Posts in a channel, oldest first, each followed by its replies when asked for. Graph does not
 * document an order for channel posts, so `since` filters rather than stopping early, within the
 * same page bound as everything else.
 */
export async function listChannelMessages(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'channel' }>,
  options: ChannelMessageOptions,
): Promise<ListResult<TeamsMessage>> {
  const { teamId, channelId } = await resolveChannel(graph, ref);
  const base = `/teams/${encode(teamId)}/channels/${encode(channelId)}/messages`;
  const cutoff = options.since?.getTime();
  const posts: TeamsMessage[] = [];
  let pages = 0;
  let complete = true;

  for await (const page of graph.pages<GraphChatMessage>(base, {
    scopes: SCOPES.channelMessages,
    query: { $top: MESSAGE_PAGE_SIZE },
    maxPages: CONTEXT_SCAN_PAGES,
  })) {
    pages += 1;
    complete = !page.hasMore;
    for (const raw of page.items) {
      if (cutoff !== undefined && raw.createdDateTime !== undefined && Date.parse(raw.createdDateTime) < cutoff)
        continue;
      const message = normalizeMessage(raw);
      if (message.kind === 'event' && options.includeEvents !== true) continue;
      posts.push(message);
    }
    if (posts.length >= options.limit) break;
  }
  if (posts.length > options.limit) complete = false;
  const kept = chronological(posts).slice(-options.limit);

  if (options.replies !== true) return { items: kept, pages, complete };

  const withReplies: TeamsMessage[] = [];
  /* One post at a time: fanning out would trip Graph's per-app throttling on a busy channel. */
  /* eslint-disable no-await-in-loop */
  for (const post of kept) {
    withReplies.push(post);
    const replies = await graph.list<GraphChatMessage>(`${base}/${encode(post.id)}/replies`, {
      scopes: SCOPES.channelMessages,
      query: { $top: MESSAGE_PAGE_SIZE },
      limit: CONTEXT_SCAN_PAGES * MESSAGE_PAGE_SIZE,
      maxPages: CONTEXT_SCAN_PAGES,
    });
    pages += replies.pages;
    withReplies.push(...chronological(replies.items.map(normalizeMessage)));
  }
  /* eslint-enable no-await-in-loop */
  return { items: withReplies, pages, complete };
}

// --- Writes (design 0004) ---

/** What a write would send: shown by `--dry-run`, and exactly what is sent otherwise. */
export interface PlannedWrite {
  readonly method: 'POST';
  readonly path: string;
  readonly body: MessageBody;
  /** The scope sending it needs. A dry run needs none of the write scopes. */
  readonly scopes: readonly string[];
}

/** A message to post: its text or HTML, and anyone to @-mention by email, UPN or user ID. */
export interface WriteInput extends MessageInput {
  readonly mentions?: readonly string[];
}

interface GraphUserRef {
  readonly id: string;
  readonly displayName?: string | null;
}

/**
 * One person, by user ID, UPN, or email address. `GET /users/{x}` takes an ID or a UPN only; an
 * address that is a mail alias, or a guest (whose UPN is `name_domain#EXT#@tenant`), is found by
 * filtering on `mail` instead. Nothing found is a `ConfigError` naming what was asked for.
 */
async function findUser(graph: GraphClient, wanted: string): Promise<GraphUserRef> {
  const select = { $select: ['id', 'displayName'] };
  try {
    return await graph.get<GraphUserRef>(`/users/${encode(wanted)}`, SCOPES.users, select);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404) || !wanted.includes('@')) throw error;
  }
  const byMail = await graph.get<{ value?: readonly GraphUserRef[] }>('/users', SCOPES.users, {
    ...select,
    // OData quotes a string with single quotes, doubled to escape.
    $filter: `mail eq '${wanted.replaceAll("'", "''")}'`,
  });
  const found = byMail.value?.[0];
  if (found === undefined) throw new ConfigError(`No user found for the mention "${wanted}".`);
  return found;
}

/**
 * Resolves each mention to a Graph user, so the message can link them. Takes an email address,
 * a UPN, or a user ID; one that matches no user is a `ConfigError` naming it, before anything is
 * posted.
 */
export async function resolveMentions(graph: GraphClient, people: readonly string[]): Promise<MentionTarget[]> {
  const resolved: MentionTarget[] = [];
  /* Sequential: a handful of lookups, and the first unknown name should stop the rest. */
  /* eslint-disable no-await-in-loop */
  for (const person of people) {
    const wanted = person.trim();
    if (wanted === '') continue;
    const user = await findUser(graph, wanted);
    resolved.push({ id: user.id, name: clean(user.displayName) ?? wanted });
  }
  /* eslint-enable no-await-in-loop */
  return resolved;
}

async function plan(
  graph: GraphClient,
  path: string,
  input: WriteInput,
  scopes: readonly string[],
): Promise<PlannedWrite> {
  // Checked before any lookup, so an empty message fails without a request.
  validateMessageInput(input);
  const mentions = await resolveMentions(graph, input.mentions ?? []);
  return { method: 'POST', path, body: buildMessageBody(input, mentions), scopes };
}

/** A new post in a channel. */
export async function planChannelPost(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'channel' }>,
  input: WriteInput,
): Promise<PlannedWrite> {
  const { teamId, channelId } = await resolveChannel(graph, ref);
  return plan(graph, `/teams/${encode(teamId)}/channels/${encode(channelId)}/messages`, input, SCOPES.channelSend);
}

/**
 * A reply in a channel thread. A reply's ref names its root, and Teams threads are one level
 * deep, so replying to a reply replies to the thread it is in.
 */
export async function planChannelReply(
  graph: GraphClient,
  ref: Extract<TeamsRef, { kind: 'channelMessage' }>,
  input: WriteInput,
): Promise<PlannedWrite> {
  const rootId = ref.rootId ?? ref.messageId;
  const path = `/teams/${encode(ref.teamId)}/channels/${encode(ref.channelId)}/messages/${encode(rootId)}/replies`;
  return plan(graph, path, input, SCOPES.channelSend);
}

/** A message in a 1:1, group, or meeting chat. Chats have no threads, so there is no chat reply. */
export async function planChatSend(graph: GraphClient, chatId: string, input: WriteInput): Promise<PlannedWrite> {
  return plan(graph, `/chats/${encode(chatId)}/messages`, input, SCOPES.chatSend);
}

/**
 * Sends a planned write and returns what Teams stored, in the same shape the read commands
 * return. Sent once: a failure that could have followed a posted message is reported, not retried.
 */
export async function sendPlanned(graph: GraphClient, planned: PlannedWrite): Promise<TeamsMessage> {
  const raw = await graph.send<GraphChatMessage>(planned.path, planned.body, planned.scopes);
  return normalizeMessage(raw);
}
