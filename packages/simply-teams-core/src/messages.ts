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

import { decodeEntities, htmlToText } from './html-text.js';
import { channelMessageRef, chatMessageRef, parseRef } from './refs.js';
import { stripControl, stripControlOneLine } from './text.js';

// --- Graph's shapes, as far as this CLI reads them ---

interface GraphIdentity {
  readonly id?: string | null;
  readonly displayName?: string | null;
}

export interface GraphChatMessage {
  readonly id: string;
  readonly replyToId?: string | null;
  readonly messageType?: string;
  readonly createdDateTime?: string;
  readonly lastEditedDateTime?: string | null;
  readonly deletedDateTime?: string | null;
  readonly subject?: string | null;
  readonly chatId?: string | null;
  readonly channelIdentity?: { readonly teamId?: string | null; readonly channelId?: string | null } | null;
  readonly from?: { readonly user?: GraphIdentity | null; readonly application?: GraphIdentity | null } | null;
  readonly body?: { readonly contentType?: string; readonly content?: string | null } | null;
  readonly attachments?: ReadonlyArray<{
    readonly id?: string | null;
    readonly contentType?: string | null;
    readonly contentUrl?: string | null;
    readonly name?: string | null;
  }>;
  readonly eventDetail?: { readonly '@odata.type'?: string } | null;
  /** Who the message @mentions. Teams often splits one person into an entry per name part. */
  readonly mentions?: ReadonlyArray<{ readonly mentioned?: { readonly user?: GraphIdentity | null } | null }> | null;
  readonly webUrl?: string | null;
}

export interface GraphSearchHit {
  readonly summary?: string;
  readonly resource?: {
    readonly id?: string;
    readonly chatId?: string | null;
    readonly channelIdentity?: { readonly teamId?: string | null; readonly channelId?: string | null } | null;
    readonly createdDateTime?: string;
    readonly from?: {
      readonly emailAddress?: { readonly name?: string | null; readonly address?: string | null } | null;
    } | null;
    readonly webUrl?: string | null;
  };
}

export interface GraphChat {
  readonly id: string;
  readonly topic?: string | null;
  readonly chatType?: string;
  readonly webUrl?: string | null;
  /** Set on a meeting chat: the meeting's join link and organizer (design 0008). */
  readonly onlineMeetingInfo?: {
    readonly joinWebUrl?: string | null;
    readonly organizer?: { readonly user?: GraphIdentity | null } | null;
  } | null;
  readonly lastMessagePreview?: {
    readonly createdDateTime?: string;
    readonly isDeleted?: boolean;
    readonly messageType?: string;
    readonly body?: { readonly contentType?: string; readonly content?: string | null } | null;
    readonly from?: { readonly user?: GraphIdentity | null; readonly application?: GraphIdentity | null } | null;
  } | null;
}

// --- The shapes this CLI returns (design 0002, The message shape) ---

export interface MessageAuthor {
  readonly name?: string;
  readonly userId?: string;
  readonly email?: string;
}

export interface ChannelLocation {
  readonly teamId: string;
  readonly channelId: string;
}

export type AttachmentKind = 'file' | 'card' | 'reference' | 'other';

export interface TeamsMessage {
  /** Pass this to `message view` to fetch the message again. */
  readonly ref: string;
  readonly id: string;
  /** `event` is a system event (call ended, member added, …), not something a person wrote. */
  readonly kind: 'message' | 'event';
  readonly chatId?: string;
  readonly channel?: ChannelLocation;
  readonly replyToId?: string;
  readonly from?: MessageAuthor;
  readonly createdAt?: string;
  readonly editedAt?: string;
  readonly deleted: boolean;
  readonly subject?: string;
  /** Written by someone in the conversation: untrusted, and already stripped of control characters. */
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name?: string; readonly kind: AttachmentKind; readonly url?: string }>;
  /** The user IDs the message @mentions, once each; absent when it mentions no one. */
  readonly mentionedUserIds?: readonly string[];
  readonly webUrl?: string;
}

/** A search hit. Graph's search returns no message body, only a highlighted summary. */
export interface TeamsSearchHit {
  readonly ref: string;
  readonly id: string;
  readonly chatId?: string;
  readonly channel?: ChannelLocation;
  readonly from?: MessageAuthor;
  readonly createdAt?: string;
  /** The matching snippet, with the matched terms in `**bold**`. */
  readonly summary: string;
  readonly webUrl?: string;
}

export interface TeamsChat {
  readonly ref: string;
  readonly id: string;
  readonly type?: string;
  readonly topic?: string;
  readonly lastMessage?: { readonly from?: string; readonly at?: string; readonly preview: string };
  readonly webUrl?: string;
}

/** How long a one-line preview may run before it is cut. */
const PREVIEW_LENGTH = 200;

function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

/** Display names are chosen by their owners, so they get the same stripping as message text. */
function displayName(value: string | null | undefined): string | undefined {
  const name = present(value);
  return name === undefined ? undefined : stripControlOneLine(name);
}

function author(from: GraphChatMessage['from']): MessageAuthor | undefined {
  const user = from?.user;
  if (user) return { name: displayName(user.displayName), userId: present(user.id) };
  const app = from?.application;
  return app ? { name: displayName(app.displayName) } : undefined;
}

function attachmentKind(contentType: string | null | undefined): AttachmentKind {
  if (contentType === 'reference') return 'file';
  if (contentType === 'messageReference') return 'reference';
  if (contentType?.startsWith('application/vnd.microsoft.card') === true) return 'card';
  return 'other';
}

/** `#microsoft.graph.callEndedEventMessageDetail` → `callEnded`. */
function eventName(detail: GraphChatMessage['eventDetail']): string {
  const type = detail?.['@odata.type'] ?? '';
  return type.replace(/^#?microsoft\.graph\./, '').replace(/EventMessageDetail$/, '') || 'event';
}

function oneLine(text: string): string {
  const line = stripControlOneLine(text);
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line;
}

/** Turns a Graph `chatMessage` into the shape every command returns. */
export function normalizeMessage(raw: GraphChatMessage): TeamsMessage {
  const attachments = (raw.attachments ?? []).map((attachment) => ({
    id: attachment.id ?? '',
    name: present(attachment.name),
    kind: attachmentKind(attachment.contentType),
    url: attachment.contentType === 'reference' ? present(attachment.contentUrl) : undefined,
  }));
  const label = (id: string): string | undefined => {
    const found = attachments.find((attachment) => attachment.id === id);
    if (found === undefined) return undefined;
    if (found.kind === 'reference') return '[quoted message]';
    if (found.kind === 'card') return '[card]';
    return `[attachment: ${found.name ?? 'unnamed'}]`;
  };

  const deleted = present(raw.deletedDateTime) !== undefined;
  const event = raw.messageType === 'systemEventMessage';
  const team = present(raw.channelIdentity?.teamId);
  const channel = present(raw.channelIdentity?.channelId);
  const chatId = present(raw.chatId);
  const replyToId = present(raw.replyToId);

  let ref: string;
  if (team !== undefined && channel !== undefined) ref = channelMessageRef(team, channel, raw.id, replyToId);
  else ref = chatMessageRef(chatId ?? '', raw.id);

  let text = '';
  if (event) text = `[event: ${eventName(raw.eventDetail)}]`;
  else if (!deleted) text = htmlToText(raw.body?.content ?? '', raw.body?.contentType ?? 'html', label);

  return {
    ref,
    id: raw.id,
    kind: event ? 'event' : 'message',
    chatId,
    channel: team !== undefined && channel !== undefined ? { teamId: team, channelId: channel } : undefined,
    replyToId,
    from: author(raw.from),
    createdAt: present(raw.createdDateTime),
    editedAt: present(raw.lastEditedDateTime),
    deleted,
    subject: present(raw.subject) === undefined ? undefined : stripControl(raw.subject ?? ''),
    text,
    attachments: attachments.map(({ name, kind, url }) => ({ name, kind, url })),
    ...mentionedIds(raw),
    webUrl: present(raw.webUrl),
  };
}

/** The distinct user IDs in `mentions[]`, as an optional field so a message with none keeps its shape. */
function mentionedIds(raw: GraphChatMessage): { mentionedUserIds?: string[] } {
  const ids = new Set<string>();
  for (const mention of raw.mentions ?? []) {
    const id = present(mention.mentioned?.user?.id);
    if (id !== undefined) ids.add(id);
  }
  return ids.size === 0 ? {} : { mentionedUserIds: [...ids] };
}

/** Renders Graph's search summary: `<c0>` marks a match and `<ddd/>` an elision. */
export function renderSummary(summary: string): string {
  const marked = summary
    .replaceAll(/<c0>([\s\S]*?)<\/c0>/gi, '**$1**')
    .replaceAll(/<ddd\s*\/?>/gi, '…')
    .replaceAll(/<[^>]+>/g, '');
  return stripControlOneLine(decodeEntities(marked));
}

/**
 * Turns a search hit into a result that can be passed back to `message view`. Search hits carry no
 * reply-to ID, but a channel reply's `webUrl` names its root post, and fetching a reply needs it,
 * so the link is preferred when it parses.
 */
export function normalizeSearchHit(hit: GraphSearchHit): TeamsSearchHit {
  const resource = hit.resource ?? {};
  const id = resource.id ?? '';
  const chatId = present(resource.chatId);
  const teamId = present(resource.channelIdentity?.teamId);
  const channelId = present(resource.channelIdentity?.channelId);
  const webUrl = present(resource.webUrl);

  let ref =
    teamId !== undefined && channelId !== undefined
      ? channelMessageRef(teamId, channelId, id)
      : chatMessageRef(chatId ?? '', id);
  if (webUrl !== undefined) {
    try {
      const parsed = parseRef(webUrl, ['chatMessage', 'channelMessage']);
      ref =
        parsed.kind === 'chatMessage'
          ? chatMessageRef(parsed.chatId, parsed.messageId)
          : channelMessageRef(parsed.teamId, parsed.channelId, parsed.messageId, parsed.rootId);
    } catch {
      // Not every hit links to Teams (search has returned Outlook links for chats); keep the IDs.
    }
  }

  const sender = resource.from?.emailAddress;
  return {
    ref,
    id,
    chatId,
    channel: teamId !== undefined && channelId !== undefined ? { teamId, channelId } : undefined,
    from: sender ? { name: displayName(sender.name), email: present(sender.address) } : undefined,
    createdAt: present(resource.createdDateTime),
    summary: renderSummary(hit.summary ?? ''),
    webUrl,
  };
}

/**
 * Graph's `chatType`, corrected where Graph reports a placeholder. Sorted by last message,
 * `/me/chats` returns some meeting chats as `unknownFutureValue`, and the
 * `Prefer: include-unknown-enum-members` header does not change that (2026-10-21 probe). Their ID
 * still says what they are.
 */
function chatType(raw: GraphChat): string | undefined {
  if (raw.chatType === 'unknownFutureValue' && raw.id.startsWith('19:meeting_')) return 'meeting';
  return raw.chatType;
}

export function normalizeChat(raw: GraphChat): TeamsChat {
  const last = raw.lastMessagePreview;
  let preview = '';
  if (last?.isDeleted === true) preview = '[deleted]';
  else if (last?.messageType === 'systemEventMessage') preview = '[event]';
  else if (last) preview = oneLine(htmlToText(last.body?.content ?? '', last.body?.contentType ?? 'html'));
  return {
    ref: raw.id,
    id: raw.id,
    type: chatType(raw),
    topic: present(raw.topic) === undefined ? undefined : stripControlOneLine(raw.topic ?? ''),
    lastMessage: last
      ? {
          from: displayName(last.from?.user?.displayName ?? last.from?.application?.displayName),
          at: present(last.createdDateTime),
          preview,
        }
      : undefined,
    webUrl: present(raw.webUrl),
  };
}
