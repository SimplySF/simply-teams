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
import { parseRef, planChatSend } from '@simplysf/simply-teams-core';
import { TeamsCommand } from '../../../shared/base-command.js';
import { deliver, messageFlags, writeInput, type WriteResult } from '../../../shared/write-output.js';

export default class ChatSend extends TeamsCommand<typeof ChatSend> {
  public static override isWrite = true;

  public static override readonly summary = 'Send a message in a chat, as you.';
  public static override readonly description =
    'Takes a chat link, a chat ref from "teams chat list", or a chat message ref (the message goes ' +
    'to that chat). It appears exactly as if you had typed it. Use --dry-run to see the request first.\n\n' +
    'Needs ChatMessage.Send, which "teams auth login --allow-writes" asks for. TEAMS_READ_ONLY refuses it.';

  public static override readonly examples = [
    {
      description: 'Answer in a chat',
      command: '<%= config.bin %> <%= command.id %> <chat-ref> --text "Thanks, on it."',
    },
  ];

  public static override readonly args = {
    chat: Args.string({ description: 'A Teams chat link, or a chat ref.', required: true }),
  };

  public static override readonly flags = { ...messageFlags };

  public async run(): Promise<WriteResult> {
    const graph = this.graph();
    const { chatId } = parseRef(this.args.chat, ['chat', 'chatMessage']);
    const planned = await planChatSend(graph, chatId, writeInput(this.flags));
    return deliver(graph, planned, this.flags['dry-run'], (message) => this.logSafe(message));
  }
}
