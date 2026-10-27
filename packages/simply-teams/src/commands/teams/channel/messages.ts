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
  type ListResult,
  listChannelMessages,
  parseDate,
  parseRef,
  type TeamsMessage,
} from '@simplysf/simply-teams-core';
import { cleanFlag, limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { renderTranscript } from '../../../shared/message-output.js';

export default class ChannelMessages extends TeamsCommand<typeof ChannelMessages> {
  public static override readonly summary = 'Read the recent posts in a channel, oldest first.';
  public static override readonly description =
    'Takes a channel link, a channel ref from "teams channel list", or "Team name/Channel name". ' +
    "Lists the posts that start threads; --replies also fetches each post's replies, one request " +
    'per post, indented beneath it.\n\n' +
    'Needs ChannelMessage.Read.All, which only a tenant administrator can consent to.';

  public static override readonly examples = [
    {
      description: 'This week in a channel, with replies',
      command: '<%= config.bin %> <%= command.id %> "Platform/General" --since 7d --replies',
    },
  ];

  public static override readonly args = {
    channel: Args.string({ description: 'A channel link, a channel ref, or "Team/Channel" by name.', required: true }),
  };

  public static override readonly flags = {
    ...cleanFlag,
    since: Flags.string({ summary: 'Only posts created on or after this date: YYYY-MM-DD, or relative like 7d.' }),
    replies: Flags.boolean({ summary: "Also fetch each post's replies.", default: false }),
    'include-events': Flags.boolean({ summary: 'Also show system events.', default: false }),
    ...limitFlag(25, 'posts'),
  };

  public async run(): Promise<ListResult<TeamsMessage>> {
    const { flags } = this;
    const ref = parseRef(this.args.channel, ['channel']);
    const result = this.cleaned(
      await listChannelMessages(this.graph(), ref, {
        since: flags.since === undefined ? undefined : parseDate(flags.since),
        limit: flags.limit,
        replies: flags.replies,
        includeEvents: flags['include-events'],
      }),
    );
    this.logSafe(result.items.length === 0 ? 'No posts.' : renderTranscript(result.items));
    this.reportList(
      result.items.filter((message) => message.replyToId === undefined).length,
      result.complete,
      flags.limit,
      'posts',
    );
    return result;
  }
}
