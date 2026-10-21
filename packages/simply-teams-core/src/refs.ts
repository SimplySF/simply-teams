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

import { ConfigError } from './errors.js';

/** A team named by ID, or by display name for a person typing it; names are resolved later. */
export type Selector = { readonly id: string } | { readonly name: string };

/** Everything a command can be pointed at. Messages are always by ID: they have no names. */
export type TeamsRef =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'chatMessage'; readonly chatId: string; readonly messageId: string }
  | { readonly kind: 'team'; readonly team: Selector }
  | { readonly kind: 'channel'; readonly team: Selector; readonly channel: Selector }
  | {
      readonly kind: 'channelMessage';
      readonly teamId: string;
      readonly channelId: string;
      readonly messageId: string;
      /** Set when the message is a reply: the root post it replies to. */
      readonly rootId?: string;
    };

export type RefKind = TeamsRef['kind'];

/** Teams web hosts across the commercial and sovereign clouds. A link from anywhere else is refused. */
const TEAMS_HOSTS = new Set([
  'teams.microsoft.com',
  'teams.cloud.microsoft',
  'gov.teams.microsoft.us',
  'dod.teams.microsoft.us',
]);

const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** 1:1, group, and meeting chats. */
const CHAT_ID = /^19:\S+@(?:thread\.v2|unq\.gbl\.spaces)$/i;
/** Standard, private, and shared channels, and the older `thread.skype` form. */
const CHANNEL_ID = /^19:\S+@thread\.(?:tacv2|skype)$/i;
/** Message IDs are the message's creation time in epoch milliseconds. */
const MESSAGE_ID = /^\d+$/;

const DESCRIBE: Readonly<Record<RefKind, string>> = {
  chat: 'a chat',
  chatMessage: 'a chat message',
  team: 'a team',
  channel: 'a channel',
  channelMessage: 'a channel message',
};

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ConfigError(`"${segment}" is not a valid link segment.`);
  }
}

/** Parses a Teams "Copy link" URL. */
function parseLink(url: URL): TeamsRef {
  if (!TEAMS_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ConfigError(`${url.hostname} is not a Microsoft Teams host; paste a link copied from Teams.`);
  }
  const [, route, kind, first, second] = url.pathname.split('/').map(decode);
  if (route !== 'l' || first === undefined)
    throw new ConfigError(`Not a Teams link this CLI understands: ${url.origin}${url.pathname}`);
  const groupId = url.searchParams.get('groupId') ?? undefined;

  switch (kind) {
    case 'message': {
      if (second === undefined || !MESSAGE_ID.test(second))
        throw new ConfigError('The message link has no message ID.');
      if (groupId === undefined) return { kind: 'chatMessage', chatId: first, messageId: second };
      const parent = url.searchParams.get('parentMessageId') ?? undefined;
      return {
        kind: 'channelMessage',
        teamId: groupId,
        channelId: first,
        messageId: second,
        // A root post's link names itself as its own parent; only a reply names another.
        ...(parent !== undefined && parent !== second && parent !== '0' ? { rootId: parent } : {}),
      };
    }
    case 'chat':
      return { kind: 'chat', chatId: first };
    case 'channel':
    case 'team':
      if (groupId === undefined) throw new ConfigError('The channel link has no groupId, so its team is unknown.');
      return kind === 'team'
        ? { kind: 'team', team: { id: groupId } }
        : { kind: 'channel', team: { id: groupId }, channel: { id: first } };
    default:
      throw new ConfigError(
        `Teams links to ${kind ?? 'that'} are not supported; use a chat, channel, or message link.`,
      );
  }
}

/** A team or channel part of a `team/channel` reference: an ID when it looks like one, else a name. */
function selector(part: string, idPattern: RegExp): Selector {
  return idPattern.test(part) ? { id: part } : { name: part };
}

/**
 * Parses the `ref` strings this CLI prints, so any result can be fed straight back in:
 *
 * - `chatId` and `chatId/messageId`
 * - `team` and `team/channel`, where either part is an ID or a display name
 * - `teamId/channelId/messageId` and `teamId/channelId/rootId/replyId`
 */
function parseChatComposite(input: string, chatId: string, rest: readonly string[]): TeamsRef {
  if (rest.length === 0) return { kind: 'chat', chatId };
  const [messageId] = rest;
  if (rest.length === 1 && messageId !== undefined && MESSAGE_ID.test(messageId)) {
    return { kind: 'chatMessage', chatId, messageId };
  }
  throw new ConfigError(`"${input}" starts with a chat ID, so it must be chatId or chatId/messageId.`);
}

/** `teamId/channelId/messageId` or `teamId/channelId/rootId/replyId`: IDs only, since messages have no names. */
function parseChannelMessage(input: string, parts: readonly string[]): TeamsRef {
  const [teamId = '', channelId = '', ...messageIds] = parts;
  const valid =
    GUID.test(teamId) &&
    CHANNEL_ID.test(channelId) &&
    (messageIds.length === 1 || messageIds.length === 2) &&
    messageIds.every((id) => MESSAGE_ID.test(id));
  if (!valid) {
    throw new ConfigError(
      `"${input}" is not a reference this CLI understands. Channel messages are teamId/channelId/messageId, ` +
        'using IDs rather than names; copy the ref from a search or list result, or paste a Teams link.',
    );
  }
  const [first = '', second] = messageIds;
  return second === undefined
    ? { kind: 'channelMessage', teamId, channelId, messageId: first }
    : { kind: 'channelMessage', teamId, channelId, rootId: first, messageId: second };
}

function parseComposite(input: string): TeamsRef {
  const parts = input.split('/').map((part) => part.trim());
  if (parts.some((part) => part === '')) throw new ConfigError(`"${input}" has an empty part.`);
  const [first = '', second] = parts;

  if (CHAT_ID.test(first)) return parseChatComposite(input, first, parts.slice(1));
  if (parts.length === 1) {
    if (CHANNEL_ID.test(first)) throw new ConfigError('A channel ID needs its team: use team/channel.');
    return { kind: 'team', team: selector(first, GUID) };
  }
  if (parts.length === 2 && second !== undefined) {
    return { kind: 'channel', team: selector(first, GUID), channel: selector(second, CHANNEL_ID) };
  }
  return parseChannelMessage(input, parts);
}

/**
 * Parses whatever a person or agent hands a command — a Teams link, or a `ref` this CLI printed —
 * and checks it is one of the kinds the command takes, so a chat link given to a channel command
 * fails with a message that says what was wanted.
 */
export function parseRef<K extends RefKind>(input: string, accepted: readonly K[]): Extract<TeamsRef, { kind: K }> {
  const text = input.trim();
  if (text === '') throw new ConfigError('A reference is required: a Teams link, or a ref from a result.');
  const ref = /^https?:\/\//i.test(text) ? parseLink(new URL(text)) : parseComposite(text);
  if (!(accepted as readonly RefKind[]).includes(ref.kind)) {
    const wanted = accepted.map((kind) => DESCRIBE[kind]).join(' or ');
    throw new ConfigError(`That is ${DESCRIBE[ref.kind]}, but this needs ${wanted}.`);
  }
  return ref as Extract<TeamsRef, { kind: K }>;
}

/** The ref string for a chat message, so results can be passed back to `message view`. */
export function chatMessageRef(chatId: string, messageId: string): string {
  return `${chatId}/${messageId}`;
}

/** The ref string for a channel message; a reply carries its root so it can be fetched again. */
export function channelMessageRef(teamId: string, channelId: string, messageId: string, rootId?: string): string {
  return rootId === undefined || rootId === messageId
    ? `${teamId}/${channelId}/${messageId}`
    : `${teamId}/${channelId}/${rootId}/${messageId}`;
}
