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

import type { MeetingTranscript, Utterance } from '@simplysf/simply-teams-core';
import { when } from './message-output.js';

function renderUtterance(utterance: Utterance): string {
  const who = utterance.speaker === undefined ? '' : `${utterance.speaker}: `;
  const mark = utterance.hit === true ? '  ◀' : '';
  const segment = utterance.segment === undefined ? '' : ` (${utterance.segment})`;
  return `[${utterance.at}]${segment} ${who}${utterance.text}${mark}`;
}

/**
 * A transcript as a conversation: a header saying which meeting and what was read, then one line
 * per utterance, a `…` between the windows `--find` returned, and where to continue if the
 * budget cut it. Matches are marked as `message view` marks its message.
 */
export function renderMeetingTranscript(result: MeetingTranscript): string {
  const { meeting } = result;
  const started = meeting.startedAt === undefined ? '' : ` · ${when(meeting.startedAt)}`;
  const organizer = meeting.organizer === undefined ? '' : ` · organized by ${meeting.organizer}`;
  const count = result.transcripts.length;
  const parts = count > 1 ? ` · ${count} transcripts, read in order` : '';
  const speakers = result.attributed ? '' : ' · speakers not named';
  const header = `━━ ${meeting.subject ?? 'Meeting'}${started}${organizer}${parts}${speakers}`;

  const lines: string[] = [];
  for (const utterance of result.utterances) {
    if (utterance.gap === true) lines.push('…');
    lines.push(renderUtterance(utterance));
  }

  const notes: string[] = [];
  if (result.note !== undefined) notes.push(`(${result.note})`);
  if (result.matched !== undefined)
    notes.push(`${result.matched} matching utterance${result.matched === 1 ? '' : 's'}`);
  if (result.truncated && result.nextStart !== undefined)
    notes.push(`Cut at --max-chars; continue with --start ${result.nextStart}`);

  return [header, lines.join('\n'), notes.join('\n')].filter((part) => part !== '').join('\n');
}
