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

/** Someone to @-mention, already resolved to a Graph user (design 0004). */
export interface MentionTarget {
  readonly id: string;
  readonly name: string;
}

/** The body of a message as a person or agent supplies it: plain text, or Teams HTML. */
export interface MessageInput {
  readonly text?: string;
  readonly html?: string;
}

/** Graph's `mentions[]` entry: links an `<at id="n">` element to a user. */
export interface GraphMention {
  readonly id: number;
  readonly mentionText: string;
  readonly mentioned: {
    readonly user: { readonly id: string; readonly displayName: string; readonly userIdentityType: 'aadUser' };
  };
}

/** The request body Graph's `POST …/messages` and `…/replies` take. */
export interface MessageBody {
  readonly body: { readonly contentType: 'html'; readonly content: string };
  readonly mentions?: readonly GraphMention[];
}

/** Escapes the five characters that change meaning in HTML, so plain text stays plain. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Plain text as Teams HTML: escaped, with each line break kept. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replaceAll(/\r?\n/g, '<br>');
}

/**
 * Builds a message body. Plain text is escaped, so `<b>` in it is shown rather than obeyed; HTML
 * is sent as given, for callers that want formatting. Mentions are placed at the start, each as
 * `@Name`, because Graph needs every `mentions[]` entry to appear in the content and a caller
 * cannot be expected to know the `<at id>` markup.
 */
export function buildMessageBody(input: MessageInput, mentions: readonly MentionTarget[] = []): MessageBody {
  const hasText = input.text !== undefined && input.text.trim() !== '';
  const hasHtml = input.html !== undefined && input.html.trim() !== '';
  if (hasText === hasHtml) {
    throw new ConfigError(
      hasText ? 'Give the message as text or as HTML, not both.' : 'The message is empty: give it some text.',
    );
  }
  const content = hasText ? textToHtml(input.text ?? '') : (input.html ?? '');
  const tags = mentions.map((person, index) => `<at id="${index}">${escapeHtml(person.name)}</at>`);
  return {
    body: { contentType: 'html', content: tags.length === 0 ? content : `${tags.join(' ')} ${content}` },
    ...(mentions.length === 0
      ? {}
      : {
          mentions: mentions.map((person, index) => ({
            id: index,
            mentionText: person.name,
            mentioned: { user: { id: person.id, displayName: person.name, userIdentityType: 'aadUser' as const } },
          })),
        }),
  };
}
