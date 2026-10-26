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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchChats, searchWords, summarize } from '../src/chat-search.js';
import { resolveTeamsConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { GraphClient } from '../src/graph-client.js';
import { searchMessages } from '../src/operations.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
let requested: TokenRequest[];

const CLIENT = '11111111-2222-3333-4444-555555555555';
const CHAT_A = '19:a@thread.v2';
const CHAT_B = '19:b@thread.v2';
const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: CLIENT });

function graph(): GraphClient {
  requested = [];
  const tokens: TokenProvider = {
    getToken: (request = {}) => {
      requested.push(request);
      return Promise.resolve({ token: 't', source: 'broker', scopes: [] });
    },
  };
  return new GraphClient(config, tokens, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
}

function raw(id: string, chatId: string, html: string, from = 'Ada', at = `2026-10-26T1${id.padStart(1, '0')}:00:00Z`) {
  return {
    id,
    messageType: 'message',
    chatId,
    createdDateTime: at,
    from: { user: { id: `u-${from.toLowerCase()}`, displayName: from } },
    body: { contentType: 'html', content: html },
  };
}

function routeChats(chats: Record<string, unknown[]>, more = false): void {
  server.route('/v1.0/me/chats', (_req, res) => {
    respondJson(res, 200, {
      value: Object.keys(chats).map((id) => ({ id, chatType: 'group', topic: `topic ${id}` })),
      ...(more ? { '@odata.nextLink': `${server.baseUrl}/v1.0/me/chats?$skiptoken=1` } : {}),
    });
  });
  for (const [id, messages] of Object.entries(chats)) {
    server.route(`/v1.0/chats/${encodeURIComponent(id)}/messages`, (_req, res) =>
      respondJson(res, 200, { value: messages }),
    );
  }
}

const consentRefusal = {
  error: { code: 'Forbidden', message: 'Access to ChatMessage in Graph API requires ChannelMessage.Read.All' },
};

beforeEach(async () => {
  server = await startTestServer();
  server.route('/v1.0/me', (_req, res) => respondJson(res, 200, { id: 'me', displayName: 'Joe AbiJaoudi' }));
});

afterEach(async () => {
  await server.close();
});

describe('searchWords and summarize', () => {
  it('keeps plain words, lower-cased, and drops KQL terms and operators', () => {
    expect(searchWords('Deploy "release freeze" from:ada sent>=2026-01-01 AND x')).toStrictEqual({
      words: ['deploy', 'release', 'freeze', 'x'],
      droppedKql: true,
    });
  });

  it('bolds every match in a window around the first one', () => {
    const long = `${'a '.repeat(100)}the deploy went fine and the next deploy is Monday`;
    const summary = summarize(long, ['deploy']);
    expect(summary).toMatch(/^…/);
    expect(summary).toContain('**deploy**');
    expect(summary.match(/\*\*deploy\*\*/g)).toHaveLength(2);
  });
});

describe('searchChats (design 0007)', () => {
  it('matches every word case-insensitively, newest first, with refs message view accepts', async () => {
    routeChats({
      [CHAT_A]: [raw('3', CHAT_A, '<p>Deploy is done</p>'), raw('1', CHAT_A, '<p>deploy the freeze note</p>')],
      [CHAT_B]: [raw('2', CHAT_B, '<p>Freeze the DEPLOY</p>'), raw('4', CHAT_B, '<p>nothing here</p>')],
    });

    const result = await searchChats(graph(), 'deploy freeze', {}, { chats: 20, limit: 25, reason: 'consent' });

    expect(result.scope).toBe('chats');
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['2', '1']);
    expect(result.items[0]?.ref).toBe(`${CHAT_B}/2`);
    expect(result.items[0]?.summary).toBe('**Freeze** the **DEPLOY**');
    expect(result.note).toContain('ChannelMessage.Read.All is not granted');
    expect(result.complete).toBe(true);
    const scopes = new Set(requested.flatMap((request) => request.scopes ?? []));
    expect([...scopes]).toStrictEqual(['Chat.Read']);
  });

  it('applies the sender, until and mentions-me filters, and says when KQL was dropped', async () => {
    routeChats({
      [CHAT_A]: [
        raw('5', CHAT_A, '<p>@Joe AbiJaoudi deploy please</p>', 'Bo', '2026-10-26T15:00:00Z'),
        raw('4', CHAT_A, '<p>deploy done</p>', 'Ada', '2026-10-26T14:00:00Z'),
        raw('3', CHAT_A, '<p>deploy soon</p>', 'Bo', '2026-10-26T13:00:00Z'),
      ],
    });
    const client = graph();

    const byBo = await searchChats(client, 'deploy', { from: 'bo' }, { chats: 5, limit: 25, reason: 'asked' });
    expect(byBo.items.map((hit) => hit.id)).toStrictEqual(['5', '3']);
    expect(byBo.note).toContain('Only chats were searched, as asked.');

    const until = await searchChats(
      client,
      'deploy',
      { until: new Date('2026-10-26T14:30:00Z') },
      { chats: 5, limit: 25, reason: 'asked' },
    );
    expect(until.items.map((hit) => hit.id)).toStrictEqual(['4', '3']);

    const mentions = await searchChats(
      client,
      'deploy from:bo',
      { mentionsMe: true },
      { chats: 5, limit: 25, reason: 'asked' },
    );
    expect(mentions.items.map((hit) => hit.id)).toStrictEqual(['5']);
    expect(mentions.note).toContain('KQL operators in the query were ignored');
  });

  it('reports incompleteness when there were more chats than it read, or more hits than the limit', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>x</p>'), raw('2', CHAT_A, '<p>x</p>')] }, true);
    const result = await searchChats(graph(), 'x', {}, { chats: 1, limit: 1, reason: 'asked' });
    expect(result.items).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  it('skips a chat it is not allowed to read, and refuses an empty query before any request', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>x</p>')], [CHAT_B]: [] });
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT_B)}/messages`, (_req, res) =>
      respondJson(res, 403, { error: { code: 'InsufficientPrivileges' } }),
    );
    const result = await searchChats(graph(), 'x', {}, { chats: 5, limit: 25, reason: 'asked' });
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['1']);

    await expect(searchChats(graph(), '', {}, { chats: 5, limit: 25, reason: 'asked' })).rejects.toThrow(ConfigError);
  });
});

describe('searchMessages falls back (design 0007)', () => {
  it('reads chats when Graph refuses for want of ChannelMessage.Read.All, and not for other failures', async () => {
    server.route('/v1.0/search/query', (_req, res) => respondJson(res, 403, consentRefusal));
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>deploy</p>')] });
    const result = await searchMessages(graph(), 'deploy', {}, 25);
    expect(result.scope).toBe('chats');
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['1']);

    server.route('/v1.0/search/query', (_req, res) =>
      respondJson(res, 403, { error: { code: 'Forbidden', message: 'blocked' } }),
    );
    await expect(searchMessages(graph(), 'deploy', {}, 25)).rejects.toThrow(/blocked/);
  });

  it('skips Graph search when asked for chats only', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>deploy</p>')] });
    const result = await searchMessages(graph(), 'deploy', {}, 25, { chatsOnly: true, chats: 3 });
    expect(result.scope).toBe('chats');
    expect(result.note).toContain('The 3 most recent chats');
    expect(server.requests.some((request) => request.url.includes('/search/query'))).toBe(false);
  });
});
