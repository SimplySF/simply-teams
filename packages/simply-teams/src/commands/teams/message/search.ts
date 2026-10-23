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
import { parseDate, searchMessages, type SearchResult } from '@simplysf/simply-teams-core';
import { cleanFlag, limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { renderHit } from '../../../shared/message-output.js';

export default class MessageSearch extends TeamsCommand<typeof MessageSearch> {
  public static override readonly summary = 'Search the chat and channel messages you can see.';
  public static override readonly description =
    'Runs a Microsoft Search query over every Teams chat and channel message you have access to. ' +
    'The query is KQL: plain words match anywhere in a message, its sender, or its attachments, and ' +
    'the flags add the documented filters. Results come in relevance order; Graph cannot sort them.\n\n' +
    'Each result is a snippet, not the whole message. Pass its ref to "teams message view" for the ' +
    'full text and, with --context, the conversation around it.\n\n' +
    'Needs ChannelMessage.Read.All, which only a tenant administrator can consent to. Graph refuses ' +
    'message search entirely without it, even for chats.';

  public static override readonly examples = [
    {
      description: 'Find where something was discussed',
      command: '<%= config.bin %> <%= command.id %> "release freeze"',
    },
    {
      description: 'Narrow to one sender in the last two weeks',
      command: '<%= config.bin %> <%= command.id %> deploy --from ada@contoso.com --since 2w',
    },
    {
      description: 'Messages that mention you',
      command: '<%= config.bin %> <%= command.id %> --mentions-me --since 7d',
    },
  ];

  public static override readonly args = {
    query: Args.string({ description: 'Words or KQL to search for. Optional when a filter flag is given.' }),
  };

  public static override readonly flags = {
    ...cleanFlag,
    from: Flags.string({ summary: 'Only messages from this person: a name or email address.' }),
    since: Flags.string({ summary: 'Only messages sent on or after this date: YYYY-MM-DD, or relative like 7d.' }),
    until: Flags.string({ summary: 'Only messages sent on or before this date.' }),
    'mentions-me': Flags.boolean({ summary: 'Only messages that @mention you.', default: false }),
    ...limitFlag(25, 'results'),
  };

  public async run(): Promise<SearchResult> {
    const { flags } = this;
    const result = this.cleaned(
      await searchMessages(
        this.graph(),
        this.args.query ?? '',
        {
          from: flags.from,
          since: flags.since === undefined ? undefined : parseDate(flags.since),
          until: flags.until === undefined ? undefined : parseDate(flags.until),
          mentionsMe: flags['mentions-me'],
        },
        flags.limit,
      ),
    );
    if (result.items.length === 0) this.log(`No messages match: ${result.query}`);
    else this.logSafe(result.items.map(renderHit).join('\n\n'));
    this.reportList(result.items.length, result.complete, flags.limit, 'results');
    return result;
  }
}
