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

import {
  DEFAULT_MEETINGS,
  formatTable,
  type ListResult,
  listMeetings,
  type TeamsMeeting,
} from '@simplysf/simply-teams-core';
import { cleanFlag, limitFlag, TeamsCommand } from '../../../shared/base-command.js';
import { truncate, when } from '../../../shared/message-output.js';

export default class MeetingList extends TeamsCommand<typeof MeetingList> {
  public static override readonly summary = 'List the meetings you were in, most recently active first.';
  public static override readonly description =
    'The meeting chats among your chats, each with its subject, organizer and join link. Pass a ' +
    'meeting\'s ref to "teams meeting transcript" for what was said, or to "teams chat messages" for ' +
    'the chat. Needs only Chat.Read. Graph has no list of meetings short of the calendar, so a ' +
    'meeting whose chat you never saw is not here.';

  public static override readonly examples = ['<%= config.bin %> <%= command.id %> --limit 10'];

  public static override readonly flags = {
    ...cleanFlag,
    ...limitFlag(DEFAULT_MEETINGS, 'meetings'),
  };

  public async run(): Promise<ListResult<TeamsMeeting>> {
    const result = this.cleaned(await listMeetings(this.graph(), this.flags.limit));
    this.logSafe(
      result.items.length === 0
        ? 'No meeting chats.'
        : formatTable(result.items, [
            { header: 'Last active', value: (meeting): unknown => when(meeting.lastActivity) },
            { header: 'Meeting', value: (meeting): unknown => truncate(meeting.subject, 40) },
            { header: 'Organizer', value: (meeting): unknown => truncate(meeting.organizer, 24) },
            { header: 'Ref', value: (meeting): unknown => meeting.ref },
          ]),
    );
    this.reportList(result.items.length, result.complete, this.flags.limit, 'meetings');
    return result;
  }
}
