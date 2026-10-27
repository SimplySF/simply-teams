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
import { formatTable, type ListResult, listChannels, parseRef, type TeamsChannel } from '@simplysf/simply-teams-core';
import { cleanFlag, TeamsCommand } from '../../../shared/base-command.js';

export default class ChannelList extends TeamsCommand<typeof ChannelList> {
  public static override readonly summary = 'List the channels in a team.';
  public static override readonly description =
    'Takes a team\'s display name, its ref from "teams team list", or a team link. Pass a channel\'s ' +
    'ref to "teams channel messages" to read it.';

  public static override readonly examples = ['<%= config.bin %> <%= command.id %> "Platform Engineering"'];

  public static override readonly args = {
    team: Args.string({ description: 'A team name, ref, or link.', required: true }),
  };

  public static override readonly flags = { ...cleanFlag };

  public async run(): Promise<ListResult<TeamsChannel>> {
    const ref = parseRef(this.args.team, ['team']);
    const result = this.cleaned(await listChannels(this.graph(), ref.team));
    this.logSafe(
      formatTable(result.items, [
        { header: 'Channel', value: (channel): unknown => channel.name },
        { header: 'Type', value: (channel): unknown => channel.membershipType },
        { header: 'Ref', value: (channel): unknown => channel.ref },
      ]),
    );
    return result;
  }
}
