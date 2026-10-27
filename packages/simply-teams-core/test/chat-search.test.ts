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
import { AuthError, ConfigError } from '../src/errors.js';
import { GraphClient } from '../src/graph-client.js';
import { searchMessages } from '../src/search.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
let requested: TokenRequest[];

const CLIENT = '11111111-2222-3333-4444-555555555555';
const CHAT_A = '19:a@thread.v2';
const CHAT_B = '19:b@thread.v2';
const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: CLIENT });
const SCAN = { chats: 5, limit: 25, reason: 'asked' } as const;

/** A provider whose token holds `granted`; with `granted` unset it is opaque, saying nothing. */
function graph(granted?: readonly string[]): GraphClient {
  requested = [];
  const tokens: TokenProvider = {
    getToken: (request = {}) => {
      requested.push(request);
      if (granted !== undefined && (request.scopes ?? []).some((scope) => !granted.includes(scope))) {
        return Promise.reject(new AuthError('Sign-in needs you to confirm it once', 401));
      }
      return Promise.resolve({ token: 't', source: 'broker', scopes: [...(granted ?? [])] });
    },
  };
  return new GraphClient(config, tokens, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
}

function raw(id: string, chatId: string, html: string, from = 'Ada', at = `2026-10-26T1${id}:00:00Z`) {
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
  it('keeps plain words, lower-cased, and drops KQL terms and operators but not times or links', () => {
    expect(searchWords('Deploy "release freeze" from:ada sent>=2026-01-01 AND x')).toStrictEqual({
      words: ['deploy', 'release', 'freeze', 'x'],
      droppedKql: true,
    });
    expect(searchWords('standup 10:30 https://contoso.sharepoint.com/x Re: plan')).toStrictEqual({
      words: ['standup', '10:30', 'https://contoso.sharepoint.com/x', 're:', 'plan'],
      droppedKql: false,
    });
  });

  it('bolds every match in a window around the first one', () => {
    const long = `${'a '.repeat(100)}the deploy went fine and the next deploy is Monday`;
    const summary = summarize(long, ['deploy']);
    expect(summary).toMatch(/^…/);
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
        // Teams' own markup: one <at> per name part, both pointing at the same user.
        {
          ...raw(
            '5',
            CHAT_A,
            '<p><at id="0">Joe</at> <at id="1">AbiJaoudi</at> deploy please</p>',
            'Bo',
            '2026-10-26T15:00:00Z',
          ),
          mentions: [
            { id: 0, mentionText: 'Joe', mentioned: { user: { id: 'me', displayName: 'Joe AbiJaoudi' } } },
            { id: 1, mentionText: 'AbiJaoudi', mentioned: { user: { id: 'me', displayName: 'Joe AbiJaoudi' } } },
          ],
        },
        raw('4', CHAT_A, '<p>deploy done</p>', 'Ada Lovelace', '2026-10-26T14:00:00Z'),
        raw('3', CHAT_A, '<p>deploy soon</p>', 'Bo', '2026-10-26T13:00:00Z'),
        // A mention shortened to a first name, and text that merely looks like a mention.
        {
          ...raw('2', CHAT_A, '<p><at id="0">Joe</at> deploy?</p>', 'Bo', '2026-10-26T12:00:00Z'),
          mentions: [{ id: 0, mentionText: 'Joe', mentioned: { user: { id: 'me', displayName: 'Joe AbiJaoudi' } } }],
        },
        raw('1', CHAT_A, '<p>@Joe AbiJaoudi deploy</p>', 'Bo', '2026-10-26T11:00:00Z'),
      ],
    });
    const client = graph();

    const byBo = await searchChats(client, 'deploy', { from: 'bo' }, SCAN);
    expect(byBo.items.map((hit) => hit.id)).toStrictEqual(['5', '3', '2', '1']);
    expect(byBo.note).toContain('Only chats were searched, as asked.');

    // An address matches by the words of its local part: chat messages carry no address.
    const byAddress = await searchChats(client, 'deploy', { from: 'ada.lovelace@contoso.com' }, SCAN);
    expect(byAddress.items.map((hit) => hit.id)).toStrictEqual(['4']);

    // `until` is a whole day, as Graph's sent<= is: the 26th includes everything sent on the 26th.
    const before = await searchChats(client, 'deploy', { until: new Date('2026-10-25T00:00:00Z') }, SCAN);
    expect(before.items).toHaveLength(0);
    const sameDay = await searchChats(client, 'deploy', { until: new Date('2026-10-26T00:00:00Z') }, SCAN);
    expect(sameDay.items.map((hit) => hit.id)).toStrictEqual(['5', '4', '3', '2', '1']);

    // `since` is a whole day too: an afternoon instant still includes that morning.
    const sinceToday = await searchChats(client, 'deploy', { since: new Date('2026-10-26T14:30:00Z') }, SCAN);
    expect(sinceToday.items.map((hit) => hit.id)).toStrictEqual(['5', '4', '3', '2', '1']);

    const mentions = await searchChats(client, 'deploy from:bo', { mentionsMe: true }, SCAN);
    // Matched by the user ID in mentions[], so split and shortened mentions count and plain text does not.
    expect(mentions.items.map((hit) => hit.id)).toStrictEqual(['5', '2']);
    expect(mentions.note).toContain('KQL operators in the query were ignored');
  });

  it('stops before a chat that cannot hold a newer hit than the ones it already has', async () => {
    server.route('/v1.0/me/chats', (_req, res) =>
      respondJson(res, 200, {
        value: [
          { id: CHAT_A, chatType: 'group', lastMessagePreview: { createdDateTime: '2026-10-26T15:00:00Z' } },
          { id: CHAT_B, chatType: 'group', lastMessagePreview: { createdDateTime: '2026-10-20T09:00:00Z' } },
        ],
      }),
    );
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT_A)}/messages`, (_req, res) =>
      respondJson(res, 200, {
        value: [
          raw('2', CHAT_A, '<p>x</p>', 'Ada', '2026-10-26T15:00:00Z'),
          raw('1', CHAT_A, '<p>x</p>', 'Ada', '2026-10-26T14:00:00Z'),
        ],
      }),
    );
    const result = await searchChats(graph(), 'x', {}, { chats: 5, limit: 2, reason: 'asked' });
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['2', '1']);
    expect(server.requests.some((request) => request.url.includes(encodeURIComponent(CHAT_B)))).toBe(false);
    expect(result.note).toContain('The 1 most recent chats');
    expect(result.note).toContain('older chats were not read');

    // With room for more hits, the older chat is still read.
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT_B)}/messages`, (_req, res) =>
      respondJson(res, 200, { value: [raw('9', CHAT_B, '<p>x</p>', 'Bo', '2026-10-20T09:00:00Z')] }),
    );
    const wider = await searchChats(graph(), 'x', {}, { chats: 5, limit: 3, reason: 'asked' });
    expect(wider.note).not.toContain('older chats were not read');
    expect(wider.items.map((hit) => hit.id)).toStrictEqual(['2', '1', '9']);
  });

  it('says complete only about the hit limit; the chat bound is in the note', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>x</p>'), raw('2', CHAT_A, '<p>x</p>')] }, true);
    const cut = await searchChats(graph(), 'x', {}, { chats: 1, limit: 1, reason: 'asked' });
    expect(cut.items).toHaveLength(1);
    expect(cut.complete).toBe(false);
    const whole = await searchChats(graph(), 'x', {}, { chats: 1, limit: 5, reason: 'asked' });
    expect(whole.complete).toBe(true);
    expect(whole.note).toContain('The 1 most recent chats');
  });

  it('caps the hits one chat may contribute when asked, so another chat still shows', async () => {
    routeChats({
      [CHAT_A]: [raw('5', CHAT_A, '<p>x</p>'), raw('4', CHAT_A, '<p>x</p>'), raw('3', CHAT_A, '<p>x</p>')],
      [CHAT_B]: [raw('1', CHAT_B, '<p>x</p>')],
    });
    const result = await searchChats(graph(), 'x', {}, { ...SCAN, limit: 3, hitsPerChat: 2 });
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['5', '4', '1']);
    expect(result.note).toContain('All 2 of your chats were read');
  });

  it('refuses a query that is only KQL, since a scan has nothing to match', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>x</p>')] });
    await expect(searchChats(graph(), 'from:ada', {}, SCAN)).rejects.toThrow(ConfigError);
    expect(server.requests).toHaveLength(0);
  });

  it('skips a chat it is not allowed to read and says so, and refuses an empty query before any request', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>x</p>')], [CHAT_B]: [] });
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT_B)}/messages`, (_req, res) =>
      respondJson(res, 403, { error: { code: 'InsufficientPrivileges' } }),
    );
    const result = await searchChats(graph(), 'x', {}, SCAN);
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['1']);
    expect(result.note).toContain('1 of them could not be read');

    await expect(searchChats(graph(), '', {}, SCAN)).rejects.toThrow(ConfigError);
  });
});

describe('searchMessages falls back (design 0007)', () => {
  it('reads chats when the broker cannot get the search scopes silently, before Graph is asked', async () => {
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>deploy</p>')] });
    const result = await searchMessages(graph(['User.Read', 'Chat.Read']), 'deploy', {}, 25);
    expect(result.scope).toBe('chats');
    expect(result.note).toContain('ChannelMessage.Read.All is not granted');
    expect(server.requests.some((request) => request.url.includes('/search/query'))).toBe(false);
    expect(requested[0]).toMatchObject({ scopes: ['Chat.Read', 'ChannelMessage.Read.All'], silentOnly: true });
  });

  it("falls back on Graph's refusal in the exact words recorded live, so a change of wording fails a test", async () => {
    // The 403 Graph returned on 2026-10-22, before admin consent, as quoted in search.ts; only the
    // granted-permissions tail, which names this tenant's grants, is left out.
    const recorded = {
      error: {
        code: 'Forbidden',
        message:
          'Access to ChatMessage in Graph API requires the following permissions: Chat.Read or Chat.ReadWrite, ' +
          'ChannelMessage.Read.All.',
        innerError: { date: '2026-10-22T14:03:11', 'request-id': 'r', 'client-request-id': 'c' },
      },
    };
    server.route('/v1.0/search/query', (_req, res) => respondJson(res, 403, recorded));
    routeChats({ [CHAT_A]: [raw('1', CHAT_A, '<p>deploy</p>')] });
    const result = await searchMessages(graph(), 'deploy', {}, 25);
    expect(result.scope).toBe('chats');
    expect(result.items.map((hit) => hit.id)).toStrictEqual(['1']);
  });

  it('reports a sign-in problem as itself, not as a missing consent', async () => {
    const broken: TokenProvider = {
      getToken: () => Promise.reject(new AuthError('Sign-in needs you to confirm it once', 401)),
    };
    const client = new GraphClient(config, broken, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
    await expect(searchMessages(client, 'deploy', {}, 25)).rejects.toThrow(/confirm it once/);
    expect(server.requests).toHaveLength(0);
  });

  it('searches Graph when the token holds the scopes', async () => {
    server.route('/v1.0/search/query', (_req, res) =>
      respondJson(res, 200, { value: [{ hitsContainers: [{ hits: [], moreResultsAvailable: false }] }] }),
    );
    const result = await searchMessages(graph(['User.Read', 'Chat.Read', 'ChannelMessage.Read.All']), 'deploy', {}, 25);
    expect(result.scope).toBe('all');
  });

  it('reads chats when Graph refuses an opaque token for want of ChannelMessage.Read.All, and not for other failures', async () => {
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
    expect(result.note).toContain('All 1 of your chats were read');
    expect(server.requests.some((request) => request.url.includes('/search/query'))).toBe(false);
  });
});
