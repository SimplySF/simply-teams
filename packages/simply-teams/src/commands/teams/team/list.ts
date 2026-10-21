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

import { formatTable, type ListResult, listTeams, type TeamsTeam } from '@simplysf/simply-teams-core';
import { limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { truncate } from '../../../shared/message-output.js';

export default class TeamList extends TeamsCommand<typeof TeamList> {
  public static override readonly summary = 'List the teams you are a member of.';
  public static override readonly description =
    'A team can be named by its display name or its ref in "teams channel list" and "teams channel messages".';

  public static override readonly examples = ['<%= config.bin %> <%= command.id %>'];

  public static override readonly flags = {
    ...limitFlag(100, 'teams'),
  };

  public async run(): Promise<ListResult<TeamsTeam>> {
    const result = await listTeams(this.graph(), this.flags.limit);
    this.logSafe(
      formatTable(result.items, [
        { header: 'Team', value: (team): unknown => team.name },
        { header: 'Description', value: (team): unknown => truncate(team.description, 60) },
        { header: 'Ref', value: (team): unknown => team.ref },
      ]),
    );
    this.reportList(result.items.length, result.complete, this.flags.limit, 'teams');
    return result;
  }
}
