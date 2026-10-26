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

import { Args, Flags } from '@oclif/core';
import {
  DEFAULT_CONTEXT,
  DEFAULT_MAX_CHARS,
  DEFAULT_THREADS,
  gatherMessageContext,
  MAX_CONTEXT,
  MAX_THREADS,
  type MessageContext,
} from '@simplysf/simply-teams-core';
import { cleanFlag, TeamsCommand } from '../../../shared/base-command.js';
import { renderThread } from '../../../shared/message-output.js';
import { searchFilterFlags, searchFiltersFrom } from '../../../shared/search-flags.js';

export default class MessageContextCommand extends TeamsCommand<typeof MessageContextCommand> {
  public static override readonly summary =
    'Find the conversations behind a question: search, then read the matching threads.';
  public static override readonly description =
    'Searches like "teams message search", groups the hits into threads, and reads each thread ' +
    'around its hits: a channel post with its replies, or the messages either side in a chat. ' +
    'Threads come in relevance order, oldest message first within each, within a character budget, ' +
    'so one call answers "where was this discussed?" with the text itself.\n\n' +
    'Needs ChannelMessage.Read.All, which only a tenant administrator can consent to; Graph refuses ' +
    'message search entirely without it.';

  public static override readonly examples = [
    {
      description: 'The threads where a change was discussed',
      command: '<%= config.bin %> <%= command.id %> "release freeze"',
    },
    {
      description: 'More threads, less of each, from the last two weeks',
      command: '<%= config.bin %> <%= command.id %> deploy --since 2w --threads 10 --context 3',
    },
  ];

  public static override readonly args = {
    query: Args.string({ description: 'Words or KQL to search for. Optional when a filter flag is given.' }),
  };

  public static override readonly flags = {
    ...cleanFlag,
    ...searchFilterFlags,
    threads: Flags.integer({
      summary: 'How many threads to read, in relevance order.',
      default: DEFAULT_THREADS,
      min: 1,
      max: MAX_THREADS,
    }),
    context: Flags.integer({
      summary: 'Messages to read around each hit.',
      default: DEFAULT_CONTEXT,
      min: 0,
      max: MAX_CONTEXT,
    }),
    'max-chars': Flags.integer({
      summary: 'A ceiling on the message text returned; long threads are trimmed around their hits.',
      default: DEFAULT_MAX_CHARS,
      min: 1,
    }),
  };

  public async run(): Promise<MessageContext> {
    const { flags } = this;
    const result = this.cleaned(
      await gatherMessageContext(this.graph(), this.args.query ?? '', searchFiltersFrom(flags), {
        threads: flags.threads,
        context: flags.context,
        maxChars: flags['max-chars'],
      }),
    );
    if (result.threads.length === 0) {
      this.log(result.searched === 0 ? `No messages match: ${result.query}` : 'No thread could be read.');
    } else {
      this.logSafe(result.threads.map(renderThread).join('\n\n'));
    }
    const notes = [
      result.skipped === 0 ? '' : `${result.skipped} more thread${result.skipped === 1 ? '' : 's'} not shown`,
      result.unplaced === 0 ? '' : `${result.unplaced} hit${result.unplaced === 1 ? '' : 's'} in no readable thread`,
    ].filter((note) => note !== '');
    const more = notes.length === 0 ? '' : ` (${notes.join('; ')})`;
    const cut = result.truncated ? ', trimmed to fit' : '';
    this.log(
      `\n${result.threads.length} thread${result.threads.length === 1 ? '' : 's'} from ${result.searched} hits${more}${cut}.`,
    );
    return result;
  }
}
