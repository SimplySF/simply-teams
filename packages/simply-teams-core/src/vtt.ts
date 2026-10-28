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

import { decodeEntities } from './html-text.js';
import { ConfigError } from './errors.js';
import { stripControlOneLine } from './text.js';

/**
 * WebVTT as Graph serves a meeting transcript (design 0008): a `WEBVTT` header, then cues, each a
 * timing line and one or more text lines, the text wrapped in a `<v Speaker>` voice tag when the
 * tenant allows speaker attribution. The unattributed form has the same cues without the tag.
 *
 * A small line parser rather than a WebVTT library: Teams emits one regular shape, and anything
 * unexpected degrades to text without timing rather than failing the whole transcript.
 */

/** One cue as it came: seconds from the transcript's start. */
export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly speaker?: string;
  readonly text: string;
}

/** What a person said, consecutive cues by the same speaker joined into one. */
export interface Utterance {
  /** `HH:MM:SS` from the first transcript's start; later segments continue the count. */
  readonly at: string;
  readonly seconds: number;
  readonly speaker?: string;
  /** Spoken by someone in the meeting: untrusted, and already stripped of control characters. */
  readonly text: string;
  /** Which transcript of a meeting with several, counted from 1; absent when there is one. */
  readonly segment?: number;
  /** Set on an utterance that matched `find`. */
  readonly hit?: boolean;
  /** Set on the first utterance after a stretch `find` left out, so a renderer can mark the gap. */
  readonly gap?: boolean;
}

/** `00:01:02.345 --> 00:01:04.000`, with the hours optional, as the WebVTT grammar allows. */
const TIMING = /^(\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}\.\d{3}/;
const VOICE_TAG = /^<v\s+([^>]*)>/i;
const ANY_TAG = /<[^>]*>/g;

/** `[hh:]mm:ss[.mmm]` to seconds; `undefined` when it is not a timestamp. */
export function parseTimestamp(text: string): number | undefined {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (match === null) return undefined;
  const [, hours = '0', minutes = '0', seconds = '0', millis = '0'] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000;
}

/** An offset a person types, `mm:ss`, `h:mm:ss` or plain seconds, for `--start`. */
export function parseOffset(text: string): number {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const seconds = parseTimestamp(trimmed);
  if (seconds === undefined) throw new ConfigError(`"${text}" is not an offset; use mm:ss or h:mm:ss.`);
  return seconds;
}

/** Whole seconds as `HH:MM:SS`. */
export function formatOffset(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
}

function cueText(lines: readonly string[]): { speaker?: string; text: string } {
  const joined = lines.join(' ').trim();
  const voice = VOICE_TAG.exec(joined);
  const speaker = voice?.[1] === undefined ? undefined : stripControlOneLine(decodeEntities(voice[1])).trim();
  const text = stripControlOneLine(decodeEntities(joined.replace(ANY_TAG, '')))
    .replaceAll(/\s+/g, ' ')
    .trim();
  return { speaker: speaker === undefined || speaker === '' ? undefined : speaker, text };
}

/**
 * Parses a transcript into cues, in order. A block whose timing line cannot be read is skipped;
 * a block with no text is dropped. The `WEBVTT` header and `NOTE` blocks are ignored.
 */
export function parseTranscript(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const unmarked = vtt.startsWith('\uFEFF') ? vtt.slice(1) : vtt;
  const blocks = unmarked.replaceAll('\r\n', '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    const timingAt = lines.findIndex((line) => TIMING.test(line.trim()));
    if (timingAt === -1) continue;
    const [startText = '', endText = ''] = lines[timingAt]?.trim().split(/\s*-->\s*/) ?? [];
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText.split(/\s+/)[0] ?? '');
    if (start === undefined || end === undefined) continue;
    const { speaker, text } = cueText(lines.slice(timingAt + 1));
    if (text === '') continue;
    cues.push({ start, end, speaker, text });
  }
  return cues;
}

/**
 * Joins consecutive cues by the same speaker into one utterance. Teams cuts a cue every few
 * seconds, so this halves the text or better without losing a word. `offset` shifts the times, so
 * a meeting's later transcripts continue the count rather than restart it.
 */
export function mergeUtterances(cues: readonly Cue[], offset = 0, segment?: number): Utterance[] {
  const out: Utterance[] = [];
  let current: { seconds: number; speaker?: string; parts: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    out.push({
      at: formatOffset(current.seconds),
      seconds: current.seconds,
      speaker: current.speaker,
      text: current.parts.join(' '),
      ...(segment === undefined ? {} : { segment }),
    });
    current = undefined;
  };
  for (const cue of cues) {
    if (current !== undefined && current.speaker === cue.speaker) {
      current.parts.push(cue.text);
      continue;
    }
    flush();
    current = { seconds: cue.start + offset, speaker: cue.speaker, parts: [cue.text] };
  }
  flush();
  return out;
}
