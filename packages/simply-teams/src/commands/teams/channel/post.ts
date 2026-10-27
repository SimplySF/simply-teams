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
import { parseRef, planChannelPost } from '@simplysf/simply-teams-core';
import { TeamsCommand } from '../../../shared/base-command.js';
import { deliver, messageFlags, writeInput, type WriteResult } from '../../../shared/write-output.js';

export default class ChannelPost extends TeamsCommand<typeof ChannelPost> {
  public static override isWrite = true;

  public static override readonly summary = 'Start a new thread in a channel, as you.';
  public static override readonly description =
    'Takes a channel link, a channel ref from "teams channel list", or "Team name/Channel name". The ' +
    'post appears exactly as if you had typed it: your name, and a notification for everyone who ' +
    'follows the channel. Use --dry-run to see the request first.\n\n' +
    'Needs ChannelMessage.Send, which "teams auth login --allow-writes" asks for. TEAMS_READ_ONLY ' +
    'refuses it.';

  public static override readonly examples = [
    {
      description: 'Announce a deploy',
      command: '<%= config.bin %> <%= command.id %> "Platform/General" --text "Deployed 2.3 to staging"',
    },
    {
      description: 'Preview a post that mentions someone',
      command:
        '<%= config.bin %> <%= command.id %> "Platform/General" --text "please review" --mention ada@contoso.com --dry-run',
    },
  ];

  public static override readonly args = {
    channel: Args.string({ description: 'A channel link, a channel ref, or "Team/Channel" by name.', required: true }),
  };

  public static override readonly flags = { ...messageFlags };

  public async run(): Promise<WriteResult> {
    const graph = this.graph();
    const planned = await planChannelPost(graph, parseRef(this.args.channel, ['channel']), writeInput(this.flags));
    return deliver(graph, planned, this.flags['dry-run'], (message) => this.logSafe(message));
  }
}
