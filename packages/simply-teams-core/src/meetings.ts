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

import { searchWords } from './chat-search.js';
import { AuthError, ConfigError, HttpError } from './errors.js';
import type { GraphClient, ListResult } from './graph-client.js';
import { DEFAULT_MAX_CHARS } from './message-context.js';
import { type GraphChat, normalizeChat } from './messages.js';
import { SCOPES } from './operations.js';
import { stripControlOneLine } from './text.js';
import { formatOffset, mergeUtterances, parseTranscript, type Utterance } from './vtt.js';

/*
 * Meeting transcripts (design 0008): the meetings a user was in, read from their meeting chats,
 * and one meeting's transcript as utterances, narrowed by words and bounded by a budget.
 */

export const DEFAULT_MEETINGS = 20;
export const MAX_MEETINGS = 100;
export const DEFAULT_FIND_CONTEXT = 2;
export const MAX_FIND_CONTEXT = 20;

/** How many chat pages `meeting list` scans for meeting chats: 200 chats. */
const MAX_CHAT_PAGES = 4;
const CHAT_PAGE_SIZE = 50;

const encode = encodeURIComponent;

/** A meeting as `meeting list` shows it: what its chat knows, without a call per meeting. */
export interface TeamsMeeting {
  /** The meeting chat's ref, which `meeting transcript`, `chat messages` and `chat send` all accept. */
  readonly ref: string;
  readonly chatRef: string;
  readonly subject?: string;
  readonly organizer?: string;
  readonly joinUrl?: string;
  /** When the chat was last written in: the nearest thing to "when" without the calendar. */
  readonly lastActivity?: string;
}

export interface MeetingInfo {
  readonly ref: string;
  /** Graph's onlineMeeting ID. */
  readonly id: string;
  readonly subject?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly organizer?: string;
  readonly joinUrl?: string;
}

export interface TranscriptOptions {
  /** Words that must all appear in an utterance; only those and their context are returned. */
  readonly find?: string;
  /** With `find`: utterances either side of each match. */
  readonly context?: number;
  /** Skip utterances before this many seconds in. */
  readonly start?: number;
  /** A ceiling on utterance text; 0 for none. */
  readonly maxChars?: number;
}

export interface MeetingTranscript {
  readonly meeting: MeetingInfo;
  /** Oldest first; a meeting stopped and restarted has several. */
  readonly transcripts: ReadonlyArray<{ readonly id: string; readonly createdAt?: string }>;
  /** False when the tenant disallows speaker names, so no utterance has a speaker. */
  readonly attributed: boolean;
  readonly utterances: readonly Utterance[];
  /** With `find`: how many utterances matched. */
  readonly matched?: number;
  readonly truncated: boolean;
  /** Pass as `start` to continue where the budget cut. */
  readonly nextStart?: string;
  readonly note?: string;
}

interface GraphOnlineMeeting {
  readonly id: string;
  readonly subject?: string | null;
  readonly startDateTime?: string | null;
  readonly endDateTime?: string | null;
  readonly joinWebUrl?: string | null;
  readonly participants?: {
    readonly organizer?: {
      readonly identity?: { readonly user?: { readonly displayName?: string | null } | null } | null;
    } | null;
  } | null;
}

interface GraphTranscript {
  readonly id: string;
  readonly createdDateTime?: string | null;
}

/** The unattributed form Graph serves when a tenant disallows speaker names (in force since July 2026). */
const UNATTRIBUTED = 'application/vnd.microsoft.graph.transcript+text';

function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : stripControlOneLine(value);
}

function meetingFromChat(raw: GraphChat): TeamsMeeting {
  const chat = normalizeChat(raw);
  return {
    ref: chat.ref,
    chatRef: chat.ref,
    subject: chat.topic,
    organizer: present(raw.onlineMeetingInfo?.organizer?.user?.displayName),
    joinUrl: present(raw.onlineMeetingInfo?.joinWebUrl),
    lastActivity: chat.lastMessage?.at,
  };
}

// --- meeting list ---

/**
 * The meeting chats among the user's chats, most recently active first. Graph has no "meetings I
 * was in" list short of the calendar, which is a scope this tool has no other reason to hold; the
 * chats are what an agent is asked about anyway.
 */
export async function listMeetings(graph: GraphClient, limit: number): Promise<ListResult<TeamsMeeting>> {
  const items: TeamsMeeting[] = [];
  let pages = 0;
  let hasMore = false;
  for await (const page of graph.pages<GraphChat>('/me/chats', {
    scopes: SCOPES.chats,
    maxPages: MAX_CHAT_PAGES,
    query: {
      $top: CHAT_PAGE_SIZE,
      $expand: 'lastMessagePreview',
      $orderby: 'lastMessagePreview/createdDateTime desc',
    },
  })) {
    pages += 1;
    hasMore = page.hasMore;
    for (const raw of page.items) {
      if (normalizeChat(raw).type === 'meeting') items.push(meetingFromChat(raw));
    }
    if (items.length >= limit) break;
  }
  return { items: items.slice(0, limit), pages, complete: !hasMore && items.length <= limit };
}

// --- meeting transcript ---

/** Steps 1 and 2 of 0008: the meeting chat's join link, then the meeting Graph holds for it. */
export async function resolveMeeting(graph: GraphClient, chatId: string): Promise<MeetingInfo> {
  // No $select: the whole chat is small, and a property name Graph will not select would fail the call.
  const chat = await graph.get<GraphChat>(`/chats/${encode(chatId)}`, SCOPES.chats);
  const joinUrl = present(chat.onlineMeetingInfo?.joinWebUrl);
  if (joinUrl === undefined) {
    throw new ConfigError(
      `${chatId} is not a meeting chat, so it has no transcript. "teams meeting list" names the chats that are.`,
    );
  }
  // OData string literals escape a quote by doubling it; a join link holds none, but the rule is cheap to honour.
  const found = await graph.get<{ value?: readonly GraphOnlineMeeting[] }>('/me/onlineMeetings', SCOPES.meetings, {
    $filter: `JoinWebUrl eq '${joinUrl.replaceAll("'", "''")}'`,
  });
  const meeting = found.value?.[0];
  if (meeting === undefined) {
    throw new HttpError(
      'No meeting with that link is on this account: you were not on its invite, or it has expired ' +
        '(Teams keeps a meeting for a limited time after it ends).',
      404,
    );
  }
  return {
    ref: chatId,
    id: meeting.id,
    subject: present(meeting.subject) ?? present(chat.topic),
    startedAt: present(meeting.startDateTime),
    endedAt: present(meeting.endDateTime),
    organizer: present(meeting.participants?.organizer?.identity?.user?.displayName),
    joinUrl,
  };
}

/** Graph's inner-error codes for the two tenant settings that govern transcript access. */
const ACCESS_DISABLED = 'GraphAccessToTranscriptsDisabled';
const ATTRIBUTION_DISALLOWED = 'SpeakerAttributionNotAllowed';

function says(error: unknown, code: string): boolean {
  return error instanceof AuthError && error.message.includes(code);
}

/** The transcript's text, attributed when the tenant allows it; `attributed: false` after a retry without speakers. */
async function fetchContent(
  graph: GraphClient,
  path: string,
  attributed: boolean,
): Promise<{ vtt: string; attributed: boolean }> {
  if (attributed) {
    try {
      return {
        vtt: await graph.getText(path, SCOPES.transcripts, { query: { $format: 'text/vtt' }, accept: 'text/vtt' }),
        attributed: true,
      };
    } catch (error) {
      if (!says(error, ATTRIBUTION_DISALLOWED)) throw error;
    }
  }
  return { vtt: await graph.getText(path, SCOPES.transcripts, { accept: UNATTRIBUTED }), attributed: false };
}

function rethrowDisabled(error: unknown): never {
  if (says(error, ACCESS_DISABLED)) {
    throw new AuthError(
      'Graph access to meeting transcripts is turned off for this tenant. An administrator changes that in the ' +
        'Teams admin center (meeting settings); nothing on this side can.',
      403,
    );
  }
  throw error;
}

interface Window {
  readonly from: number;
  readonly to: number;
}

/** The utterances around each hit, overlapping windows merged, in order. */
function windows(utterances: readonly Utterance[], hits: ReadonlySet<number>, context: number): Window[] {
  const out: Window[] = [];
  for (const index of [...hits].sort((a, b) => a - b)) {
    const from = Math.max(0, index - context);
    const to = Math.min(utterances.length - 1, index + context);
    const last = out.at(-1);
    if (last !== undefined && from <= last.to + 1) out[out.length - 1] = { from: last.from, to: Math.max(last.to, to) };
    else out.push({ from, to });
  }
  return out;
}

function matches(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/** Narrows to the hits and their context when `find` is given; marks the hits. */
function narrow(
  utterances: readonly Utterance[],
  find: string | undefined,
  context: number,
): { utterances: Utterance[]; matched?: number } {
  if (find === undefined || find.trim() === '') return { utterances: [...utterances] };
  const { words } = searchWords(find);
  if (words.length === 0)
    throw new ConfigError('--find needs words to look for; KQL operators are not understood here.');
  const lowered = words.map((word) => word.toLowerCase());
  const hits = new Set<number>();
  utterances.forEach((utterance, index) => {
    if (matches(utterance.text, lowered)) hits.add(index);
  });
  const out: Utterance[] = [];
  for (const window of windows(utterances, hits, context)) {
    for (let index = window.from; index <= window.to; index += 1) {
      const utterance = utterances[index];
      if (utterance === undefined) continue;
      out.push({
        ...utterance,
        ...(hits.has(index) ? { hit: true } : {}),
        ...(index === window.from && out.length > 0 ? { gap: true } : {}),
      });
    }
  }
  return { utterances: out, matched: hits.size };
}

/** Takes utterances in order until their text would pass the budget; always at least one, so a call makes progress. */
function budget(utterances: readonly Utterance[], maxChars: number): { kept: Utterance[]; next?: Utterance } {
  if (maxChars <= 0) return { kept: [...utterances] };
  const kept: Utterance[] = [];
  let used = 0;
  for (const utterance of utterances) {
    if (kept.length > 0 && used + utterance.text.length > maxChars) return { kept, next: utterance };
    kept.push(utterance);
    used += utterance.text.length;
  }
  return { kept };
}

/**
 * Step 3 of 0008 and what follows: every transcript of the meeting, oldest first, as utterances
 * with a running clock, then `start`, `find` and the budget applied in that order.
 */
export async function readTranscript(
  graph: GraphClient,
  chatId: string,
  options: TranscriptOptions = {},
): Promise<MeetingTranscript> {
  const meeting = await resolveMeeting(graph, chatId);
  const base = `/me/onlineMeetings/${encode(meeting.id)}/transcripts`;
  const listed = await graph
    .get<{ value?: readonly GraphTranscript[] }>(base, SCOPES.transcripts)
    .catch(rethrowDisabled);
  const transcripts = [...(listed.value ?? [])]
    .sort((a, b) => (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? ''))
    .map((transcript) => ({ id: transcript.id, createdAt: present(transcript.createdDateTime) }));

  const all: Utterance[] = [];
  const unreadable: string[] = [];
  let attributed = true;
  let offset = 0;
  /* Each transcript's clock starts where the previous one ended, so they are read in order. */
  /* eslint-disable no-await-in-loop */
  for (const [index, transcript] of transcripts.entries()) {
    let content: { vtt: string; attributed: boolean };
    try {
      content = await fetchContent(graph, `${base}/${encode(transcript.id)}/content`, attributed);
    } catch (error) {
      if (says(error, ACCESS_DISABLED) || transcripts.length === 1) rethrowDisabled(error);
      unreadable.push(transcript.id);
      continue;
    }
    attributed = content.attributed;
    const cues = parseTranscript(content.vtt);
    all.push(...mergeUtterances(cues, offset, transcripts.length > 1 ? index + 1 : undefined));
    offset += cues.at(-1)?.end ?? 0;
  }
  /* eslint-enable no-await-in-loop */

  const notes: string[] = [];
  if (transcripts.length === 0) {
    notes.push('No transcript: transcription was not turned on for this meeting, or it is still being processed.');
  }
  if (!attributed && all.length > 0) notes.push('Speakers are not named: this tenant disallows speaker attribution.');
  if (unreadable.length > 0) notes.push(`${unreadable.length} of ${transcripts.length} transcripts could not be read.`);

  const started = all.filter((utterance) => utterance.seconds >= (options.start ?? 0));
  const narrowed = narrow(started, options.find, options.context ?? DEFAULT_FIND_CONTEXT);
  if (narrowed.matched === 0) notes.push('Nothing in the transcript matched every word.');
  const { kept, next } = budget(narrowed.utterances, options.maxChars ?? DEFAULT_MAX_CHARS);

  return {
    meeting,
    transcripts,
    attributed,
    utterances: kept,
    ...(narrowed.matched === undefined ? {} : { matched: narrowed.matched }),
    truncated: next !== undefined,
    ...(next === undefined ? {} : { nextStart: formatOffset(next.seconds) }),
    ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
  };
}
