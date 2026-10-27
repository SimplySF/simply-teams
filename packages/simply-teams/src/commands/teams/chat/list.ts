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

import { formatTable, type ListResult, listChats, type TeamsChat } from '@simplysf/simply-teams-core';
import { cleanFlag, limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { truncate, when } from '../../../shared/message-output.js';

export default class ChatList extends TeamsCommand<typeof ChatList> {
  public static override readonly summary = 'List your chats, most recently active first.';
  public static override readonly description =
    'Shows 1:1, group, and meeting chats with their last message. A chat with no topic is labelled ' +
    'by whoever sent its last message. Pass a chat\'s ref to "teams chat messages" to read it.';

  public static override readonly examples = ['<%= config.bin %> <%= command.id %> --limit 10'];

  public static override readonly flags = {
    ...cleanFlag,
    ...limitFlag(20, 'chats'),
  };

  public async run(): Promise<ListResult<TeamsChat>> {
    const result = this.cleaned(await listChats(this.graph(), this.flags.limit));
    this.logSafe(
      formatTable(result.items, [
        { header: 'Last active', value: (chat): unknown => when(chat.lastMessage?.at) },
        { header: 'Type', value: (chat): unknown => chat.type },
        { header: 'Chat', value: (chat): unknown => truncate(chat.topic ?? chat.lastMessage?.from, 40) },
        { header: 'Last message', value: (chat): unknown => truncate(chat.lastMessage?.preview, 60) },
        { header: 'Ref', value: (chat): unknown => chat.ref },
      ]),
    );
    this.reportList(result.items.length, result.complete, this.flags.limit, 'chats');
    return result;
  }
}
