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
import { resolveTeamsConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { GraphClient } from '../src/graph-client.js';
import { gatherMessageContext } from '../src/message-context.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
let requested: TokenRequest[];

const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';
const CHAT = '19:chat@thread.v2';
const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: TEAM });
const channelBase = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;
const chatBase = `/v1.0/chats/${encodeURIComponent(CHAT)}/messages`;

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

function raw(id: string, text: string, where: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    messageType: 'message',
    createdDateTime: new Date(Date.UTC(2026, 9, 23, 12, 0, 0) + Number(id) * 1000).toISOString(),
    from: { user: { id: 'u', displayName: 'Ada' } },
    body: { contentType: 'html', content: `<p>${text}</p>` },
    ...where,
    ...extra,
  };
}

const channelWhere = { channelIdentity: { teamId: TEAM, channelId: CHANNEL } };

/** A search hit shaped like Graph's, with the webUrl a channel reply carries (its root is in the link). */
function hit(id: string, summary: string, where: 'channel' | 'chat', rootId?: string) {
  const resource =
    where === 'channel'
      ? {
          id,
          channelIdentity: { teamId: TEAM, channelId: CHANNEL },
          webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/${id}?groupId=${TEAM}&parentMessageId=${rootId ?? id}`,
        }
      : { id, chatId: CHAT };
  return {
    hitId: id,
    summary,
    resource: { '@odata.type': '#microsoft.graph.chatMessage', ...resource, from: { user: { displayName: 'Ada' } } },
  };
}

function routeSearch(hits: unknown[], more = false): void {
  server.route('/v1.0/search/query', (_req, res) => {
    respondJson(res, 200, { value: [{ hitsContainers: [{ hits, moreResultsAvailable: more }] }] });
  });
}

function routeChannelThread(rootId: string, replies: string[]): void {
  server.route(`${channelBase}/${rootId}`, (_req, res) =>
    respondJson(res, 200, raw(rootId, `root ${rootId}`, channelWhere)),
  );
  server.route(`${channelBase}/${rootId}/replies`, (_req, res) =>
    respondJson(res, 200, { value: replies.map((id) => raw(id, `reply ${id}`, channelWhere, { replyToId: rootId })) }),
  );
  // A reply hit is fetched by its own path before its thread is read around it.
  for (const id of replies) {
    server.route(`${channelBase}/${rootId}/replies/${id}`, (_req, res) =>
      respondJson(res, 200, raw(id, `reply ${id}`, channelWhere, { replyToId: rootId })),
    );
  }
}

beforeEach(async () => {
  server = await startTestServer();
  server.route('/v1.0/me/joinedTeams', (_req, res) =>
    respondJson(res, 200, { value: [{ id: TEAM, displayName: 'Platform' }] }),
  );
  server.route(`/v1.0/teams/${TEAM}/channels`, (_req, res) =>
    respondJson(res, 200, { value: [{ id: CHANNEL, displayName: 'General', membershipType: 'standard' }] }),
  );
  server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}`, (_req, res) =>
    respondJson(res, 200, { id: CHAT, topic: null, chatType: 'oneOnOne' }),
  );
});

afterEach(async () => {
  await server.close();
});

describe('gatherMessageContext (design 0006)', () => {
  it('groups hits into threads in relevance order, reads each once around its hit, and names where it is', async () => {
    routeSearch([
      hit('105', 'a reply', 'channel', '100'),
      hit('7', 'in a chat', 'chat'),
      hit('100', 'the root', 'channel'),
      hit('9', 'chat again', 'chat'),
    ]);
    routeChannelThread('100', ['101', '105']);
    server.route(chatBase, (_req, res) => {
      respondJson(res, 200, {
        value: [
          raw('9', 'nine', { chatId: CHAT }),
          raw('8', 'eight', { chatId: CHAT }),
          raw('7', 'seven', { chatId: CHAT }),
        ],
      });
    });
    server.route(`${chatBase}/7`, (_req, res) => respondJson(res, 200, raw('7', 'seven', { chatId: CHAT })));

    const result = await gatherMessageContext(graph(), 'deploy', {}, { threads: 5, context: 10, maxChars: 24_000 });

    expect(result.threads.map((thread) => [thread.kind, thread.where, thread.hits])).toStrictEqual([
      ['channel', 'Platform / General', 2],
      ['chat', 'oneOnOne chat', 2],
    ]);
    expect(result.threads[0]?.messages.map((message) => message.id)).toStrictEqual(['100', '101', '105']);
    expect(result.threads[0]?.hitIds).toStrictEqual(['105', '100']);
    expect(result.threads[1]?.messages.map((message) => message.id)).toStrictEqual(['7', '8', '9']);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
    // The channel thread was read once (its root and replies), not once per hit, and the hit came from it.
    expect(server.requests.filter((request) => request.url.startsWith(`${channelBase}/100`))).toHaveLength(2);
    const scopes = requested.flatMap((request) => request.scopes ?? []);
    expect(scopes).toContain('ChannelMessage.Read.All');
    expect(scopes).toContain('Chat.Read');
  });

  it('returns only the threads asked for and counts the rest as skipped', async () => {
    routeSearch([hit('100', 'one', 'channel'), hit('200', 'two', 'channel'), hit('300', 'three', 'channel')]);
    routeChannelThread('100', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 5, maxChars: 24_000 });
    expect(result.threads).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it('trims a long thread from the ends furthest from its hits to fit the budget', async () => {
    routeSearch([hit('103', 'the hit', 'channel', '100')]);
    routeChannelThread('100', ['101', '102', '103', '104', '105']);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 10, maxChars: 220 });
    const thread = result.threads[0];
    expect(thread?.truncated).toBe(true);
    expect(thread?.messages.map((message) => message.id)).toContain('103');
    expect(thread?.messages.length).toBeLessThan(6);
    expect(result.truncated).toBe(true);
  });

  it('skips a thread that cannot be read, such as a meeting chat the user has left', async () => {
    routeSearch([hit('7', 'gone', 'chat'), hit('100', 'fine', 'channel')]);
    server.route(`${chatBase}/7`, (_req, res) => respondJson(res, 403, { error: { code: 'InsufficientPrivileges' } }));
    routeChannelThread('100', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 5, context: 0, maxChars: 24_000 });
    expect(result.threads.map((thread) => thread.kind)).toStrictEqual(['channel']);
    expect(result.skipped).toBe(1);
  });

  it('leaves where unset when a name lookup fails, rather than failing the call', async () => {
    server.route('/v1.0/me/joinedTeams', (_req, res) => respondJson(res, 500, { error: { code: 'boom' } }));
    server.route(`/v1.0/teams/${TEAM}/channels`, (_req, res) => respondJson(res, 500, { error: { code: 'boom' } }));
    routeSearch([hit('100', 'one', 'channel')]);
    routeChannelThread('100', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 0, maxChars: 24_000 });
    expect(result.threads[0]?.where).toBeUndefined();
  });

  it('counts a hit that belongs to no thread as unplaced, apart from skipped threads', async () => {
    routeSearch([hit('100', 'one', 'channel'), { hitId: 'x', summary: 'no ids', resource: { id: '123' } }]);
    routeChannelThread('100', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 5, context: 0, maxChars: 24_000 });
    expect(result.searched).toBe(2);
    expect(result.threads).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.unplaced).toBe(1);
  });

  it('keeps a thread whose root and last reply both match, dropping its middle to fit', async () => {
    routeSearch([hit('100', 'the root', 'channel'), hit('105', 'the last reply', 'channel', '100')]);
    routeChannelThread('100', ['101', '102', '103', '104', '105']);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 10, maxChars: 220 });
    const thread = result.threads[0];
    expect(result.skipped).toBe(0);
    expect(thread?.truncated).toBe(true);
    const ids = thread?.messages.map((message) => message.id) ?? [];
    expect(ids[0]).toBe('100');
    expect(ids.at(-1)).toBe('105');
    expect(ids.length).toBeLessThan(6);
    expect(thread?.hits).toBe(2);
  });

  it('fails the call on throttling that outlasted the retries, rather than skipping the thread', async () => {
    routeSearch([hit('7', 'busy', 'chat'), hit('100', 'fine', 'channel')]);
    server.route(`${chatBase}/7`, (_req, res) => respondJson(res, 429, { error: { code: 'TooManyRequests' } }));
    routeChannelThread('100', []);
    await expect(gatherMessageContext(graph(), 'x', {}, { threads: 5, context: 0, maxChars: 24_000 })).rejects.toThrow(
      /429/,
    );
    expect(server.requests.some((request) => request.url.includes('/messages/100'))).toBe(false);
  });

  it('counts only the hits a chat thread shows, when a later hit falls outside the window read', async () => {
    routeSearch([hit('5', 'first', 'chat'), hit('40', 'much later', 'chat')]);
    server.route(`${chatBase}/5`, (_req, res) => respondJson(res, 200, raw('5', 'first', { chatId: CHAT })));
    server.route(chatBase, (_req, res) =>
      respondJson(res, 200, { value: ['7', '6', '5', '4', '3'].map((id) => raw(id, `m ${id}`, { chatId: CHAT })) }),
    );
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 2, maxChars: 24_000 });
    expect(result.threads[0]?.hits).toBe(1);
    expect(result.threads[0]?.hitIds).toStrictEqual(['5']);
  });

  it('skips a thread whose message was deleted since it was indexed, rather than failing the call', async () => {
    routeSearch([hit('900', 'gone', 'channel'), hit('100', 'fine', 'channel')]);
    server.route(`${channelBase}/900`, (_req, res) => respondJson(res, 404, { error: { code: 'NotFound' } }));
    server.route(`${channelBase}/900/replies`, (_req, res) => respondJson(res, 404, { error: { code: 'NotFound' } }));
    routeChannelThread('100', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 5, context: 2, maxChars: 24_000 });
    expect(result.threads.map((thread) => thread.messages[0]?.id)).toStrictEqual(['100']);
    expect(result.skipped).toBe(1);
  });

  it('stops reading once the budget is spent', async () => {
    routeSearch([hit('100', 'one', 'channel'), hit('200', 'two', 'channel'), hit('300', 'three', 'channel')]);
    routeChannelThread('100', ['101', '102']);
    routeChannelThread('200', []);
    routeChannelThread('300', []);
    const result = await gatherMessageContext(graph(), 'x', {}, { threads: 3, context: 5, maxChars: 150 });
    expect(result.threads).toHaveLength(1);
    expect(result.skipped).toBe(2);
    expect(result.truncated).toBe(true);
    expect(server.requests.some((request) => request.url.includes('/messages/200'))).toBe(false);
  });

  it('refuses out-of-range options before searching', async () => {
    await expect(gatherMessageContext(graph(), 'x', {}, { threads: 0, context: 0, maxChars: 1 })).rejects.toThrow(
      ConfigError,
    );
    await expect(gatherMessageContext(graph(), 'x', {}, { threads: 1, context: 99, maxChars: 1 })).rejects.toThrow(
      ConfigError,
    );
    expect(server.requests).toHaveLength(0);
  });
});
