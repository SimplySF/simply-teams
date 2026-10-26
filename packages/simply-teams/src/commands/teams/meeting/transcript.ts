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
  DEFAULT_FIND_CONTEXT,
  DEFAULT_MAX_CHARS,
  MAX_FIND_CONTEXT,
  type MeetingTranscript,
  parseOffset,
  parseRef,
  readTranscript,
} from '@simplysf/simply-teams-core';
import { cleanFlag, TeamsCommand } from '../../../shared/base-command.js';
import { renderMeetingTranscript } from '../../../shared/meeting-output.js';

export default class MeetingTranscriptCommand extends TeamsCommand<typeof MeetingTranscriptCommand> {
  public static override readonly summary = 'Read what was said in a meeting: its transcript, by speaker and time.';
  public static override readonly description =
    'Takes a meeting join link, a meeting chat link or ref, or a ref from "teams meeting list". ' +
    'Consecutive lines by one speaker are joined, so an hour of talk reads as a conversation rather ' +
    'than captions. --find keeps only the utterances holding every given word, with --context ' +
    'utterances either side; --start skips ahead; --max-chars caps what is printed and the last ' +
    'line says where to continue.\n\n' +
    'Needs OnlineMeetings.Read and OnlineMeetingTranscript.Read.All; the second needs a tenant ' +
    "administrator's consent. A meeting has a transcript only if transcription was turned on " +
    'during it, and only after it has been processed.';

  public static override readonly examples = [
    {
      description: 'Where the deploy script came up in a meeting',
      command: '<%= config.bin %> <%= command.id %> <meeting-ref> --find "deploy script"',
    },
    {
      description: 'The second part of a long meeting',
      command: '<%= config.bin %> <%= command.id %> <meeting-ref> --start 32:00',
    },
  ];

  public static override readonly args = {
    meeting: Args.string({
      description: 'A meeting join link, a meeting chat link or ref, or a ref from "teams meeting list".',
      required: true,
    }),
  };

  public static override readonly flags = {
    ...cleanFlag,
    find: Flags.string({ summary: 'Only utterances holding every one of these words, with their context.' }),
    context: Flags.integer({
      char: 'c',
      summary: 'With --find: how many utterances to show either side of a match.',
      default: DEFAULT_FIND_CONTEXT,
      min: 0,
      max: MAX_FIND_CONTEXT,
    }),
    start: Flags.string({ summary: 'Skip utterances before this offset into the meeting: mm:ss or h:mm:ss.' }),
    'max-chars': Flags.integer({
      summary: 'Stop after this much utterance text; 0 for all of it.',
      default: DEFAULT_MAX_CHARS,
      min: 0,
    }),
  };

  public async run(): Promise<MeetingTranscript> {
    const { flags } = this;
    const ref = parseRef(this.args.meeting, ['chat', 'chatMessage']);
    const result = this.cleaned(
      await readTranscript(this.graph(), ref.chatId, {
        find: flags.find,
        context: flags.context,
        start: flags.start === undefined ? undefined : parseOffset(flags.start),
        maxChars: flags['max-chars'],
      }),
    );
    this.logSafe(renderMeetingTranscript(result));
    return result;
  }
}
