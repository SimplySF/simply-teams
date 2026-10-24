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

import type { ContextThread, TeamsMessage, TeamsSearchHit } from '@simplysf/simply-teams-core';

/** `2026-10-21 14:03` in local time: the JSON keeps the exact ISO timestamp. */
export function when(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Cuts a one-line value for a table cell; the full text is always in `--json`. */
export function truncate(text: string | undefined, length: number): string {
  if (text === undefined) return '—';
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `${prefix}${line}`))
    .join('\n');
}

/**
 * One message as a transcript entry: a header line, then the text. Replies are indented under
 * their post, and the message a `message view` was asked about is marked, so it stands out
 * among its context.
 */
export function renderMessage(message: TeamsMessage, focus = false): string {
  const name = message.kind === 'event' ? 'Teams' : (message.from?.name ?? '(unknown sender)');
  const notes = [
    message.editedAt === undefined ? '' : ' (edited)',
    message.deleted ? ' (deleted)' : '',
    focus ? '  ◀' : '',
  ].join('');
  const header = `── ${name} · ${when(message.createdAt)}${notes}`;
  const subject = message.subject === undefined ? '' : `Subject: ${message.subject}\n`;
  const files = message.attachments
    .filter((attachment) => attachment.kind === 'file')
    .map(
      (attachment) =>
        `[file: ${attachment.name ?? 'unnamed'}]${attachment.url === undefined ? '' : ` ${attachment.url}`}`,
    );
  const body = [subject + (message.deleted ? '(this message was deleted)' : message.text), ...files]
    .filter((part) => part !== '')
    .join('\n');
  const entry = `${header}\n${body}`;
  return message.replyToId === undefined ? entry : indent(entry, '    ');
}

export function renderTranscript(messages: readonly TeamsMessage[], focusId?: string): string {
  return messages.map((message) => renderMessage(message, message.id === focusId)).join('\n\n');
}

/** One thread from `message context`: where it is, how many messages matched, then its transcript with the hits marked. */
export function renderThread(thread: ContextThread): string {
  const where = thread.where ?? (thread.kind === 'chat' ? 'a chat' : 'a channel');
  const hits = `${thread.hits} matching message${thread.hits === 1 ? '' : 's'}`;
  const cut = thread.truncated ? ', trimmed to fit' : '';
  const hitIds = new Set(thread.hitIds);
  const body = thread.messages.map((message) => renderMessage(message, hitIds.has(message.id))).join('\n\n');
  const notes = thread.warnings.map((warning) => `(${warning})`).join('\n');
  return [`━━ ${where} · ${hits}${cut}`, body, notes, `ref: ${thread.ref}`].filter((part) => part !== '').join('\n');
}

export function renderHit(hit: TeamsSearchHit): string {
  const where = hit.channel === undefined ? 'chat' : 'channel';
  return [
    `${when(hit.createdAt)}  ${hit.from?.name ?? hit.from?.email ?? '(unknown sender)'}  [${where}]`,
    `  ${hit.summary}`,
    `  ref: ${hit.ref}`,
  ].join('\n');
}
