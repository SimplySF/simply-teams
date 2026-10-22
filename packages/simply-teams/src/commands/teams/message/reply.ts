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

import { Args } from '@oclif/core';
import { ConfigError, parseRef, planChannelReply } from '@simplysf/simply-teams-core';
import { TeamsCommand } from '../../../shared/base-command.js';
import { deliver, messageFlags, writeInput, type WriteResult } from '../../../shared/write-output.js';

export default class MessageReply extends TeamsCommand<typeof MessageReply> {
  public static override isWrite = true;

  public static override readonly summary = "Reply in a channel message's thread, as you.";
  public static override readonly description =
    'Takes a channel message link, or a ref from search or a list. Teams threads are one level ' +
    'deep, so replying to a reply replies to the thread it is in. Chats have no threads: to answer ' +
    'in a chat, use "teams chat send". Use --dry-run to see the request first.\n\n' +
    'Needs ChannelMessage.Send, which "teams auth login --allow-writes" asks for. TEAMS_READ_ONLY ' +
    'refuses it.';

  public static override readonly examples = [
    {
      description: 'Reply to a message found by search',
      command: '<%= config.bin %> <%= command.id %> <message-ref> --text "Agreed, shipping Friday."',
    },
  ];

  public static override readonly args = {
    message: Args.string({ description: 'A channel message link, or a ref from a result.', required: true }),
  };

  public static override readonly flags = { ...messageFlags };

  public async run(): Promise<WriteResult> {
    const ref = parseRef(this.args.message, ['channelMessage', 'chatMessage']);
    if (ref.kind === 'chatMessage') {
      throw new ConfigError(
        `That is a chat message, and chats have no threads. Send to the chat instead: teams chat send ${ref.chatId}`,
      );
    }
    const graph = this.graph();
    const planned = await planChannelReply(graph, ref, writeInput(this.flags));
    return deliver(graph, planned, this.flags['dry-run'], (message) => this.logSafe(message));
  }
}
