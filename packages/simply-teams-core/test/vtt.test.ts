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

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { formatOffset, mergeUtterances, parseOffset, parseTimestamp, parseTranscript } from '../src/vtt.js';

const VTT = [
  'WEBVTT',
  '',
  'NOTE made by Teams',
  '',
  '00:00:01.000 --> 00:00:03.500',
  '<v Ada Lovelace>We should ship on &quot;Friday&quot;.</v>',
  '',
  '1',
  '00:00:03.600 --> 00:00:05.000',
  '<v Ada Lovelace>If the tests pass.</v>',
  '',
  '00:00:05.200 --> 00:00:07.000',
  '<v Bo>Agreed, \u001b[2Jbut <i>only</i> then.</v>',
  '',
  'this block has no timing',
  '',
  '01:02:03.000 --> 01:02:04.000',
  'No speaker here',
  '',
].join('\n');

describe('parseTranscript', () => {
  it('reads cues with and without a voice tag, dropping inner tags, entities and control characters', () => {
    // The escape character goes; what followed it stays, as every message body is treated.
    expect(parseTranscript(VTT)).toStrictEqual([
      { start: 1, end: 3.5, speaker: 'Ada Lovelace', text: 'We should ship on "Friday".' },
      { start: 3.6, end: 5, speaker: 'Ada Lovelace', text: 'If the tests pass.' },
      { start: 5.2, end: 7, speaker: 'Bo', text: 'Agreed, [2Jbut only then.' },
      { start: 3723, end: 3724, speaker: undefined, text: 'No speaker here' },
    ]);
  });

  it('tolerates Windows line endings, a byte-order mark, and a cue with no text', () => {
    const text = '﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n<v A>hi</v>\r\n\r\n00:03.000 --> 00:04.000\r\n\r\n';
    expect(parseTranscript(text)).toStrictEqual([{ start: 1, end: 2, speaker: 'A', text: 'hi' }]);
  });

  it('returns nothing for text that is not WebVTT', () => {
    expect(parseTranscript('<html>not a transcript</html>')).toStrictEqual([]);
  });
});

describe('mergeUtterances', () => {
  it('joins consecutive cues by one speaker and starts a new utterance on a change', () => {
    expect(mergeUtterances(parseTranscript(VTT))).toStrictEqual([
      { at: '00:00:01', seconds: 1, speaker: 'Ada Lovelace', text: 'We should ship on "Friday". If the tests pass.' },
      { at: '00:00:05', seconds: 5.2, speaker: 'Bo', text: 'Agreed, [2Jbut only then.' },
      { at: '01:02:03', seconds: 3723, speaker: undefined, text: 'No speaker here' },
    ]);
  });

  it('shifts a later segment by the offset and labels it', () => {
    const cues = [{ start: 2, end: 3, speaker: 'A', text: 'later' }];
    expect(mergeUtterances(cues, 3600, 2)).toStrictEqual([
      { at: '01:00:02', seconds: 3602, speaker: 'A', text: 'later', segment: 2 },
    ]);
  });
});

describe('offsets', () => {
  it('parses what a person types and formats what the result shows', () => {
    expect(parseOffset('12:03')).toBe(723);
    expect(parseOffset('1:02:03')).toBe(3723);
    expect(parseOffset('90')).toBe(90);
    expect(() => parseOffset('noon')).toThrow(ConfigError);
    expect(parseTimestamp('00:00:01.5')).toBe(1.5);
    expect(formatOffset(3723.9)).toBe('01:02:03');
  });
});
