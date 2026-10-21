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
import { type ListResult, listChatMessages, parseDate, parseRef, type TeamsMessage } from '@simplysf/simply-teams-core';
import { limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { renderTranscript } from '../../../shared/message-output.js';

export default class ChatMessages extends TeamsCommand<typeof ChatMessages> {
  public static override readonly summary = 'Read the recent messages in a chat, oldest first.';
  public static override readonly description =
    'Takes a chat link or a chat ref from "teams chat list". Reads back from the newest message ' +
    'until --limit messages are collected or --since is passed, then prints them as a transcript. ' +
    'System events such as calls starting and members joining are left out unless --include-events ' +
    'is passed.\n\n' +
    'This needs only Chat.Read, so it works before an administrator has consented to message search.';

  public static override readonly examples = [
    {
      description: 'What was said in a chat this week',
      command: '<%= config.bin %> <%= command.id %> <chat-ref> --since 7d',
    },
  ];

  public static override readonly args = {
    chat: Args.string({ description: 'A Teams chat link, or a chat ref.', required: true }),
  };

  public static override readonly flags = {
    since: Flags.string({ summary: 'Stop at messages older than this: YYYY-MM-DD, or relative like 7d.' }),
    'include-events': Flags.boolean({
      summary: 'Also show system events (calls, membership changes).',
      default: false,
    }),
    ...limitFlag(50, 'messages'),
  };

  public async run(): Promise<ListResult<TeamsMessage>> {
    const { flags } = this;
    const ref = parseRef(this.args.chat, ['chat', 'chatMessage']);
    const result = await listChatMessages(this.graph(), ref.chatId, {
      since: flags.since === undefined ? undefined : parseDate(flags.since),
      limit: flags.limit,
      includeEvents: flags['include-events'],
    });
    this.logSafe(result.items.length === 0 ? 'No messages.' : renderTranscript(result.items));
    this.reportList(result.items.length, result.complete, flags.limit, 'messages');
    return result;
  }
}
