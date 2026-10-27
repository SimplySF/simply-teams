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

import { Flags } from '@oclif/core';
import {
  DEFAULT_CHATS,
  MAX_CHATS,
  parseDate,
  type SearchFilters,
  type SearchOptions,
} from '@simplysf/simply-teams-core';

/** The filters every search-shaped command takes, worded once (0002, 0006). */
export const searchFilterFlags = {
  from: Flags.string({ summary: 'Only messages from this person: a name or email address.' }),
  since: Flags.string({ summary: 'Only messages sent on or after this date: YYYY-MM-DD, or relative like 7d.' }),
  until: Flags.string({ summary: 'Only messages sent on or before this date.' }),
  'mentions-me': Flags.boolean({ summary: 'Only messages that @mention you.', default: false }),
};

/** How a search may fall back to the user's chats (design 0007). */
export const fallbackFlags = {
  'chats-only': Flags.boolean({
    summary:
      'Read your recent chats instead of searching; what happens anyway when ChannelMessage.Read.All is not granted.',
    default: false,
  }),
  chats: Flags.integer({
    summary: 'How many recent chats a chat scan reads.',
    default: DEFAULT_CHATS,
    min: 1,
    max: MAX_CHATS,
  }),
};

export function searchOptionsFrom(flags: { 'chats-only'?: boolean; chats?: number }): SearchOptions {
  return { chatsOnly: flags['chats-only'], chats: flags.chats };
}

/** Reads the search filter flags into what core searches with. */
export function searchFiltersFrom(flags: {
  from?: string;
  since?: string;
  until?: string;
  'mentions-me'?: boolean;
}): SearchFilters {
  return {
    from: flags.from,
    since: flags.since === undefined ? undefined : parseDate(flags.since),
    until: flags.until === undefined ? undefined : parseDate(flags.until),
    mentionsMe: flags['mentions-me'],
  };
}
