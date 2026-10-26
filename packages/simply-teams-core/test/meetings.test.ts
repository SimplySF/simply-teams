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

import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTeamsConfig } from '../src/config.js';
import { AuthError, ConfigError, HttpError } from '../src/errors.js';
import { GraphClient } from '../src/graph-client.js';
import { listMeetings, readTranscript, resolveMeeting } from '../src/meetings.js';
import { parseRef } from '../src/refs.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
let requested: TokenRequest[];

const CLIENT = '11111111-2222-3333-4444-555555555555';
const CHAT = '19:meeting_abc@thread.v2';
const JOIN = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(CHAT)}/0?context=%7B%22Tid%22%3A%22t%22%7D`;
const MEETING = 'MSo1N2Y5';
const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: CLIENT });

function graph(): GraphClient {
  requested = [];
  const tokens: TokenProvider = {
    getToken: (request = {}) => {
      requested.push(request);
      return Promise.resolve({ token: 't', source: 'environment', scopes: [] });
    },
  };
  return new GraphClient(config, tokens, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
}

function vtt(...cues: Array<[string, string, string]>): string {
  return [
    'WEBVTT',
    '',
    ...cues.flatMap(([at, who, text]) => [`${at} --> ${at.slice(0, -3)}999`, `<v ${who}>${text}</v>`, '']),
  ].join('\n');
}

function respondText(response: ServerResponse, status: number, body: string, type = 'text/vtt'): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

function meetingChat(id = CHAT): Record<string, unknown> {
  return {
    id,
    chatType: 'meeting',
    topic: 'Release planning',
    onlineMeetingInfo: { joinWebUrl: JOIN, organizer: { user: { id: 'u1', displayName: 'Ada' } } },
    lastMessagePreview: { createdDateTime: '2026-10-20T10:00:00Z', body: { contentType: 'text', content: 'hi' } },
  };
}

/** The three-step path of 0008, with one transcript unless `transcripts` says otherwise. */
function routeMeeting(transcripts: Array<{ id: string; created: string; body: string }>): void {
  server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}`, (_req, res) => respondJson(res, 200, meetingChat()));
  server.route('/v1.0/me/onlineMeetings', (req, res) => {
    const filter = new URL(req.url ?? '/', 'http://x').searchParams.get('$filter');
    if (filter !== `JoinWebUrl eq '${JOIN}'`) {
      respondJson(res, 400, { error: { code: 'BadRequest', message: `unexpected filter ${filter ?? ''}` } });
      return;
    }
    respondJson(res, 200, {
      value: [
        {
          id: MEETING,
          subject: 'Release planning',
          startDateTime: '2026-10-20T09:00:00Z',
          endDateTime: '2026-10-20T10:00:00Z',
          joinWebUrl: JOIN,
          participants: { organizer: { identity: { user: { displayName: 'Ada' } } } },
        },
      ],
    });
  });
  server.route(`/v1.0/me/onlineMeetings/${MEETING}/transcripts`, (_req, res) =>
    respondJson(res, 200, { value: transcripts.map((t) => ({ id: t.id, createdDateTime: t.created })) }),
  );
  for (const transcript of transcripts) {
    server.route(`/v1.0/me/onlineMeetings/${MEETING}/transcripts/${transcript.id}/content`, (_req, res) =>
      respondText(res, 200, transcript.body),
    );
  }
}

const ONE = vtt(
  ['00:00:01.000', 'Ada', 'We ship Friday.'],
  ['00:00:03.000', 'Ada', 'If tests pass.'],
  ['00:00:05.000', 'Bo', 'The deploy script is broken.'],
  ['00:00:08.000', 'Ada', 'Then fix the deploy script first.'],
  ['00:00:12.000', 'Bo', 'Fine.'],
);

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe('listMeetings', () => {
  it('keeps only meeting chats, reading the organizer and join link from each', async () => {
    server.route('/v1.0/me/chats', (_req, res) =>
      respondJson(res, 200, {
        value: [
          { id: '19:one@thread.v2', chatType: 'oneOnOne' },
          meetingChat(),
          { id: '19:meeting_x@thread.v2', chatType: 'unknownFutureValue', topic: 'Standup' },
        ],
      }),
    );
    const result = await listMeetings(graph(), 10);
    expect(result).toStrictEqual({
      pages: 1,
      complete: true,
      items: [
        {
          ref: CHAT,
          chatRef: CHAT,
          subject: 'Release planning',
          organizer: 'Ada',
          joinUrl: JOIN,
          lastActivity: '2026-10-20T10:00:00Z',
        },
        {
          ref: '19:meeting_x@thread.v2',
          chatRef: '19:meeting_x@thread.v2',
          subject: 'Standup',
          organizer: undefined,
          joinUrl: undefined,
          lastActivity: undefined,
        },
      ],
    });
    expect(requested.map((request) => request.scopes)).toStrictEqual([['Chat.Read']]);
  });

  it('stops at the limit and says the list was cut', async () => {
    server.route('/v1.0/me/chats', (_req, res) =>
      respondJson(res, 200, { value: [meetingChat('19:meeting_a@thread.v2'), meetingChat('19:meeting_b@thread.v2')] }),
    );
    const result = await listMeetings(graph(), 1);
    expect(result.items.map((item) => item.ref)).toStrictEqual(['19:meeting_a@thread.v2']);
    expect(result.complete).toBe(false);
  });
});

describe('resolveMeeting', () => {
  it('refuses a chat that is not a meeting before asking for any meeting', async () => {
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}`, (_req, res) =>
      respondJson(res, 200, { id: CHAT, chatType: 'group', topic: 'Lunch' }),
    );
    await expect(resolveMeeting(graph(), CHAT)).rejects.toThrow(ConfigError);
    expect(server.requests.map((request) => request.url.split('?')[0])).toStrictEqual([
      `/v1.0/chats/${encodeURIComponent(CHAT)}`,
    ]);
  });

  it('reports a meeting the account cannot see as not found, with the expiry wording', async () => {
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}`, (_req, res) => respondJson(res, 200, meetingChat()));
    server.route('/v1.0/me/onlineMeetings', (_req, res) => respondJson(res, 200, { value: [] }));
    await expect(resolveMeeting(graph(), CHAT)).rejects.toThrow(/expired/);
  });

  it('parses a meeting join link to the same chat a chat ref names', () => {
    expect(parseRef(JOIN, ['chat'])).toStrictEqual({ kind: 'chat', chatId: CHAT });
    expect(parseRef(`${CHAT}/1729512345678`, ['chat', 'chatMessage']).chatId).toBe(CHAT);
  });
});

describe('readTranscript', () => {
  it("returns merged utterances with a running clock, naming each call's scope", async () => {
    routeMeeting([{ id: 'tr1', created: '2026-10-20T10:01:00Z', body: ONE }]);
    const result = await readTranscript(graph(), CHAT);
    expect(result.meeting).toStrictEqual({
      ref: CHAT,
      id: MEETING,
      subject: 'Release planning',
      startedAt: '2026-10-20T09:00:00Z',
      endedAt: '2026-10-20T10:00:00Z',
      organizer: 'Ada',
      joinUrl: JOIN,
    });
    expect(result.transcripts).toStrictEqual([{ id: 'tr1', createdAt: '2026-10-20T10:01:00Z' }]);
    expect(result.attributed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.utterances.map((u) => `${u.at} ${u.speaker ?? '?'}: ${u.text}`)).toStrictEqual([
      '00:00:01 Ada: We ship Friday. If tests pass.',
      '00:00:05 Bo: The deploy script is broken.',
      '00:00:08 Ada: Then fix the deploy script first.',
      '00:00:12 Bo: Fine.',
    ]);
    expect(requested.map((request) => request.scopes)).toStrictEqual([
      ['Chat.Read'],
      ['OnlineMeetings.Read'],
      ['OnlineMeetingTranscript.Read.All'],
      ['OnlineMeetingTranscript.Read.All'],
    ]);
    const content = server.requests.find((request) => request.url.includes('/content'));
    expect(content?.url).toContain('%24format=text%2Fvtt');
  });

  it('narrows to the hits and their context, merging windows and marking the hits', async () => {
    routeMeeting([{ id: 'tr1', created: '2026-10-20T10:01:00Z', body: ONE }]);
    const result = await readTranscript(graph(), CHAT, { find: 'Deploy SCRIPT', context: 1 });
    expect(result.matched).toBe(2);
    expect(result.utterances.map((u) => [u.at, u.hit ?? false])).toStrictEqual([
      ['00:00:01', false],
      ['00:00:05', true],
      ['00:00:08', true],
      ['00:00:12', false],
    ]);
  });

  it('says so when nothing matches, and refuses a find with no words', async () => {
    routeMeeting([{ id: 'tr1', created: '2026-10-20T10:01:00Z', body: ONE }]);
    const result = await readTranscript(graph(), CHAT, { find: 'kubernetes' });
    expect(result.utterances).toStrictEqual([]);
    expect(result.matched).toBe(0);
    expect(result.note).toMatch(/matched/);
    await expect(readTranscript(graph(), CHAT, { find: 'from:ada' })).rejects.toThrow(ConfigError);
  });

  it('skips to start, stops at the budget, and says where to continue', async () => {
    routeMeeting([{ id: 'tr1', created: '2026-10-20T10:01:00Z', body: ONE }]);
    const result = await readTranscript(graph(), CHAT, { start: 5, maxChars: 40 });
    expect(result.utterances.map((u) => u.at)).toStrictEqual(['00:00:05']);
    expect(result.truncated).toBe(true);
    expect(result.nextStart).toBe('00:00:08');
    const rest = await readTranscript(graph(), CHAT, { start: 8, maxChars: 0 });
    expect(rest.utterances.map((u) => u.at)).toStrictEqual(['00:00:08', '00:00:12']);
    expect(rest.truncated).toBe(false);
  });

  it('reads several transcripts oldest first, continuing the clock and labelling the segment', async () => {
    routeMeeting([
      { id: 'later', created: '2026-10-20T10:30:00Z', body: vtt(['00:00:02.000', 'Bo', 'Second half.']) },
      { id: 'first', created: '2026-10-20T10:01:00Z', body: vtt(['00:00:01.000', 'Ada', 'First half.']) },
    ]);
    const result = await readTranscript(graph(), CHAT);
    expect(result.transcripts.map((t) => t.id)).toStrictEqual(['first', 'later']);
    expect(result.utterances).toStrictEqual([
      { at: '00:00:01', seconds: 1, speaker: 'Ada', text: 'First half.', segment: 1 },
      { at: '00:00:03', seconds: 3.999, speaker: 'Bo', text: 'Second half.', segment: 2 },
    ]);
  });

  it('fetches the unattributed form once when the tenant disallows speaker names', async () => {
    routeMeeting([{ id: 'tr1', created: '2026-10-20T10:01:00Z', body: '' }]);
    server.route(`/v1.0/me/onlineMeetings/${MEETING}/transcripts/tr1/content`, (req, res) => {
      if (req.headers.accept === 'text/vtt') {
        respondJson(res, 403, {
          error: {
            code: 'Forbidden',
            message: 'Speaker attribution is disabled.',
            innerError: { code: 'SpeakerAttributionNotAllowed' },
          },
        });
        return;
      }
      respondText(res, 200, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nno names here\n', req.headers.accept);
    });
    const result = await readTranscript(graph(), CHAT);
    expect(result.attributed).toBe(false);
    expect(result.utterances).toStrictEqual([
      { at: '00:00:01', seconds: 1, speaker: undefined, text: 'no names here' },
    ]);
    expect(result.note).toMatch(/not named/);
    expect(server.requests.filter((request) => request.url.includes('/content'))).toHaveLength(2);
  });

  it('reports the tenant setting when Graph access to transcripts is off, without retrying', async () => {
    routeMeeting([]);
    server.route(`/v1.0/me/onlineMeetings/${MEETING}/transcripts`, (_req, res) =>
      respondJson(res, 403, {
        error: {
          code: 'Forbidden',
          message: 'Graph API access to transcripts is disabled for this tenant.',
          innerError: { code: 'GraphAccessToTranscriptsDisabled' },
        },
      }),
    );
    await expect(readTranscript(graph(), CHAT)).rejects.toThrow(/Teams admin center/);
    expect(server.requests.filter((request) => request.url.endsWith('/transcripts'))).toHaveLength(1);
  });

  it('says there is no transcript rather than failing', async () => {
    routeMeeting([]);
    const result = await readTranscript(graph(), CHAT);
    expect(result.utterances).toStrictEqual([]);
    expect(result.note).toMatch(/No transcript/);
  });

  it('passes any other refusal through as the auth error it is', async () => {
    routeMeeting([]);
    server.route(`/v1.0/me/onlineMeetings/${MEETING}/transcripts`, (_req, res) =>
      respondJson(res, 403, {
        error: { code: 'Forbidden', message: 'Missing scope OnlineMeetingTranscript.Read.All' },
      }),
    );
    await expect(readTranscript(graph(), CHAT)).rejects.toThrow(AuthError);
    await expect(readTranscript(graph(), CHAT)).rejects.toThrow(/OnlineMeetingTranscript.Read.All/);
    expect(HttpError).toBeDefined();
  });
});
