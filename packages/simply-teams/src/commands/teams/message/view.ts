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
import { MAX_CONTEXT, type MessageView, parseRef, viewMessage } from '@simplysf/simply-teams-core';
import { TeamsCommand } from '../../../shared/base-command.js';
import { renderMessage, renderTranscript } from '../../../shared/message-output.js';

export default class MessageViewCommand extends TeamsCommand<typeof MessageViewCommand> {
  public static override readonly summary = 'Show one message in full, optionally with the conversation around it.';
  public static override readonly description =
    'Takes a Teams link ("Copy link" on any message) or a ref from another command\'s output. ' +
    'With --context, also shows the conversation: for a channel message, its root post and the ' +
    'replies nearest it; for a chat message, the messages either side. A chat has no "messages ' +
    'around this one" lookup, so context walks back through at most the 500 most recent messages.';

  public static override readonly examples = [
    {
      description: 'Read a message someone linked you to',
      command: '<%= config.bin %> <%= command.id %> "https://teams.microsoft.com/l/message/19%3A…/1729512345678?…"',
    },
    {
      description: 'See five messages either side of a search hit',
      command: '<%= config.bin %> <%= command.id %> <ref> --context 5',
    },
  ];

  public static override readonly args = {
    ref: Args.string({ description: 'A Teams message link, or a message ref from a result.', required: true }),
  };

  public static override readonly flags = {
    context: Flags.integer({
      char: 'c',
      summary: 'How many messages to show on each side of this one.',
      default: 0,
      min: 0,
      max: MAX_CONTEXT,
    }),
  };

  public async run(): Promise<MessageView> {
    const ref = parseRef(this.args.ref, ['chatMessage', 'channelMessage']);
    const view = await viewMessage(this.graph(), ref, this.flags.context);
    for (const warning of view.warnings) this.warn(warning);
    this.logSafe(
      view.thread.length === 0 ? renderMessage(view.message) : renderTranscript(view.thread, view.message.id),
    );
    return view;
  }
}
