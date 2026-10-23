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
import { AuthError, ConfigError } from '../src/errors.js';
import { GraphClient } from '../src/graph-client.js';
import {
  listChannelMessages,
  listChatMessages,
  listChats,
  planChannelPost,
  planChannelReply,
  planChatSend,
  resolveChannel,
  searchMessages,
  sendPlanned,
  viewMessage,
} from '../src/operations.js';
import { parseRef } from '../src/refs.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
let requested: TokenRequest[];

const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';
const CHAT = '19:chat@thread.v2';
const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: TEAM });

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

/** A Graph chatMessage created `minutesAgo` before a fixed instant, newest first by ID. */
function message(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(id),
    messageType: 'message',
    chatId: CHAT,
    createdDateTime: new Date(Date.UTC(2026, 9, 21, 12, 0) - (1000 - id) * 60_000).toISOString(),
    from: { user: { id: 'u', displayName: 'Ada' } },
    body: { contentType: 'html', content: `<p>message ${id}</p>` },
    ...extra,
  };
}

/** Serves `ids` newest first in pages of `size`, linked by nextLink the way Graph links them. */
function routeChat(ids: number[], size = 3): void {
  server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages`, (req, res) => {
    const skip = Number(new URL(req.url ?? '', server.baseUrl).searchParams.get('$skiptoken') ?? '0');
    const page = ids.slice(skip, skip + size).map((id) => message(id));
    const next =
      skip + size < ids.length
        ? `${server.baseUrl}/v1.0/chats/${encodeURIComponent(CHAT)}/messages?$skiptoken=${skip + size}`
        : undefined;
    respondJson(res, 200, { value: page, ...(next === undefined ? {} : { '@odata.nextLink': next }) });
  });
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe('searchMessages', () => {
  it('pages by from/size until Graph says there is no more, asking for both search scopes', async () => {
    const bodies: unknown[] = [];
    server.route('/v1.0/search/query', (_req, res, body) => {
      const request = (JSON.parse(body) as { requests: Array<{ from: number; query: { queryString: string } }> })
        .requests[0];
      bodies.push(request);
      const from = request?.from ?? 0;
      respondJson(res, 200, {
        value: [
          {
            hitsContainers: [
              {
                hits:
                  from === 0
                    ? [{ summary: 'a', resource: { id: '1', chatId: CHAT } }]
                    : [{ summary: 'b', resource: { id: '2', chatId: CHAT } }],
                moreResultsAvailable: from === 0,
              },
            ],
          },
        ],
      });
    });

    const result = await searchMessages(graph(), 'deploy', { mentionsMe: true }, 10);

    expect(result.query).toBe('deploy IsMentioned:true');
    expect(result.items.map((hit) => hit.ref)).toStrictEqual([`${CHAT}/1`, `${CHAT}/2`]);
    expect(result.complete).toBe(true);
    expect(bodies).toMatchObject([{ from: 0 }, { from: 1 }]);
    expect(requested[0]?.scopes).toStrictEqual(['Chat.Read', 'ChannelMessage.Read.All']);
  });
});

describe('listChatMessages', () => {
  it('stops paging at the --since cutoff and returns oldest first', async () => {
    routeChat([999, 998, 997, 996, 995, 994, 993, 992, 991]);

    // 999 is one minute before noon; a cutoff of 11:55 keeps 999..995.
    const result = await listChatMessages(graph(), CHAT, { since: new Date(Date.UTC(2026, 9, 21, 11, 55)), limit: 50 });

    expect(result.items.map((item) => item.id)).toStrictEqual(['995', '996', '997', '998', '999']);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(2); // the third page is never fetched
  });

  it('reports a limit that cut the history short', async () => {
    routeChat([999, 998, 997, 996, 995]);
    const result = await listChatMessages(graph(), CHAT, { limit: 2 });
    expect(result.items.map((item) => item.id)).toStrictEqual(['998', '999']);
    expect(result.complete).toBe(false);
  });

  it('names the left-meeting case behind a 403 InsufficientPrivileges', async () => {
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages`, (_req, res) => {
      respondJson(res, 403, { error: { code: 'Forbidden', message: 'InsufficientPrivileges' } });
    });
    const error = await listChatMessages(graph(), CHAT, { limit: 5 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/meeting chat you are no longer part of/);
  });
});

describe('viewMessage', () => {
  it('returns a chat message alone when no context is asked for', async () => {
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages/995`, (_req, res) =>
      respondJson(res, 200, message(995)),
    );
    const view = await viewMessage(graph(), { kind: 'chatMessage', chatId: CHAT, messageId: '995' });
    expect(view).toMatchObject({ message: { id: '995', text: 'message 995' }, thread: [], warnings: [] });
  });

  it('gathers context either side of a chat message, oldest first, stopping once it has enough', async () => {
    server.route(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages/996`, (_req, res) =>
      respondJson(res, 200, message(996)),
    );
    routeChat([999, 998, 997, 996, 995, 994, 993, 992, 991], 3);

    const view = await viewMessage(graph(), { kind: 'chatMessage', chatId: CHAT, messageId: '996' }, 2);

    expect(view.thread.map((item) => item.id)).toStrictEqual(['994', '995', '996', '997', '998']);
    // Pages 1 and 2 reach 994; the third page is not needed.
    expect(
      server.requests.filter((request) => request.url.includes('/messages?') || request.url.endsWith('/messages')),
    ).toHaveLength(2);
  });

  it('fetches a channel reply through its root, with the thread around it', async () => {
    const base = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;
    const channelMessage = (id: number, replyTo?: number): Record<string, unknown> =>
      message(id, {
        chatId: null,
        replyToId: replyTo === undefined ? null : String(replyTo),
        channelIdentity: { teamId: TEAM, channelId: CHANNEL },
      });
    server.route(`${base}/100/replies/103`, (_req, res) => respondJson(res, 200, channelMessage(103, 100)));
    server.route(`${base}/100`, (_req, res) => respondJson(res, 200, channelMessage(100)));
    server.route(`${base}/100/replies`, (_req, res) =>
      respondJson(res, 200, { value: [105, 104, 103, 102, 101].map((id) => channelMessage(id, 100)) }),
    );

    const view = await viewMessage(
      graph(),
      { kind: 'channelMessage', teamId: TEAM, channelId: CHANNEL, rootId: '100', messageId: '103' },
      1,
    );

    expect(view.message.ref).toBe(`${TEAM}/${CHANNEL}/100/103`);
    expect(view.thread.map((item) => item.id)).toStrictEqual(['100', '102', '103', '104']);
    expect(requested.every((request) => request.scopes?.[0] === 'ChannelMessage.Read.All')).toBe(true);
  });

  it('refuses a context outside 0..50', async () => {
    await expect(viewMessage(graph(), { kind: 'chatMessage', chatId: CHAT, messageId: '1' }, 51)).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('listChats', () => {
  it('asks for the most recently active chats first', async () => {
    server.route('/v1.0/me/chats', (_req, res) =>
      respondJson(res, 200, { value: [{ id: CHAT, chatType: 'group', topic: 'Release' }] }),
    );
    const result = await listChats(graph(), 5);
    expect(result.items).toMatchObject([{ ref: CHAT, type: 'group', topic: 'Release' }]);
    const query = new URL(server.requests[0]?.url ?? '', server.baseUrl).searchParams;
    expect(query.get('$orderby')).toBe('lastMessagePreview/createdDateTime desc');
    expect(query.get('$expand')).toBe('lastMessagePreview');
  });
});

describe('channels by name', () => {
  beforeEach(() => {
    server.route('/v1.0/me/joinedTeams', (_req, res) =>
      respondJson(res, 200, {
        value: [
          { id: TEAM, displayName: 'Platform' },
          { id: 'other', displayName: 'Payments' },
        ],
      }),
    );
    server.route(`/v1.0/teams/${TEAM}/channels`, (_req, res) =>
      respondJson(res, 200, { value: [{ id: CHANNEL, displayName: 'General', membershipType: 'standard' }] }),
    );
  });

  it('resolves "Team/Channel" names case-insensitively', async () => {
    await expect(
      resolveChannel(graph(), { kind: 'channel', team: { name: 'platform' }, channel: { name: 'GENERAL' } }),
    ).resolves.toStrictEqual({ teamId: TEAM, channelId: CHANNEL });
  });

  it('says so when no joined team has the name', async () => {
    await expect(
      resolveChannel(graph(), { kind: 'channel', team: { name: 'Nope' }, channel: { name: 'General' } }),
    ).rejects.toThrow(/No team you belong to is named "Nope"/);
  });

  it('lists posts oldest first and fetches replies only when asked', async () => {
    const base = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;
    const post = (id: number): Record<string, unknown> =>
      message(id, { chatId: null, channelIdentity: { teamId: TEAM, channelId: CHANNEL } });
    server.route(base, (_req, res) => respondJson(res, 200, { value: [post(20), post(10)] }));
    server.route(`${base}/10/replies`, (_req, res) =>
      respondJson(res, 200, {
        value: [message(11, { chatId: null, replyToId: '10', channelIdentity: { teamId: TEAM, channelId: CHANNEL } })],
      }),
    );
    server.route(`${base}/20/replies`, (_req, res) => respondJson(res, 200, { value: [] }));

    const plain = await listChannelMessages(
      graph(),
      { kind: 'channel', team: { id: TEAM }, channel: { id: CHANNEL } },
      { limit: 10 },
    );
    expect(plain.items.map((item) => item.id)).toStrictEqual(['10', '20']);

    const threaded = await listChannelMessages(
      graph(),
      { kind: 'channel', team: { id: TEAM }, channel: { id: CHANNEL } },
      { limit: 10, replies: true },
    );
    expect(threaded.items.map((item) => item.id)).toStrictEqual(['10', '11', '20']);
  });
});

describe('writes (design 0004)', () => {
  const base = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;

  it('posts to a channel, naming ChannelMessage.Send, and returns the stored message in the read shape', async () => {
    let sent: unknown;
    server.route(base, (req, res, body) => {
      sent = JSON.parse(body) as unknown;
      respondJson(res, 201, message(7, { chatId: undefined, channelIdentity: { teamId: TEAM, channelId: CHANNEL } }));
    });
    const client = graph();
    const planned = await planChannelPost(client, parseRef(`${TEAM}/${CHANNEL}`, ['channel']), { text: 'hi <all>' });
    const posted = await sendPlanned(client, planned);

    expect(sent).toStrictEqual({ body: { contentType: 'html', content: 'hi &lt;all&gt;' } });
    expect(requested.at(-1)?.scopes).toStrictEqual(['ChannelMessage.Send']);
    expect(posted.ref).toBe(`${TEAM}/${CHANNEL}/7`);
    expect(posted.text).toBe('message 7');
  });

  it('replies to the thread a reply is in, since Teams threads are one level deep', async () => {
    const planned = await planChannelReply(graph(), parseRef(`${TEAM}/${CHANNEL}/100/105`, ['channelMessage']), {
      text: 'agreed',
    });
    expect(planned.path).toBe(`/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages/100/replies`);
    expect(planned.scopes).toStrictEqual(['ChannelMessage.Send']);
  });

  it('plans a write without sending anything, so a dry run needs no write scope', async () => {
    const planned = await planChatSend(graph(), CHAT, { text: 'draft' });
    expect(planned).toStrictEqual({
      method: 'POST',
      path: `/chats/${encodeURIComponent(CHAT)}/messages`,
      body: { body: { contentType: 'html', content: 'draft' } },
      scopes: ['ChatMessage.Send'],
    });
    expect(server.requests).toHaveLength(0);
  });

  it('resolves a mention with User.ReadBasic.All before posting, and refuses an unknown one', async () => {
    server.route('/v1.0/users/ada%40example.test', (_req, res) => {
      respondJson(res, 200, { id: 'u-ada', displayName: 'Ada' });
    });
    server.route('/v1.0/users/nobody%40example.test', (_req, res) => {
      respondJson(res, 404, { error: { code: 'Request_ResourceNotFound' } });
    });
    server.route('/v1.0/users', (_req, res) => {
      respondJson(res, 200, { value: [] });
    });

    const planned = await planChatSend(graph(), CHAT, { text: 'see this', mentions: ['ada@example.test'] });
    expect(planned.body.body.content).toBe('<at id="0">Ada</at> see this');
    expect(requested.at(-1)?.scopes).toStrictEqual(['User.ReadBasic.All']);

    await expect(planChatSend(graph(), CHAT, { text: 'x', mentions: ['nobody@example.test'] })).rejects.toThrow(
      /No user found for the mention "nobody@example.test"/,
    );
  });

  it('finds a mention by mail when the address is not a UPN, as for an alias or a guest', async () => {
    server.route('/v1.0/users/ada.lovelace%40contoso.com', (_req, res) => {
      respondJson(res, 404, { error: { code: 'Request_ResourceNotFound' } });
    });
    let filter: string | null = null;
    server.route('/v1.0/users', (req, res) => {
      filter = new URL(req.url ?? '', server.baseUrl).searchParams.get('$filter');
      respondJson(res, 200, { value: [{ id: 'u-alias', displayName: "Ada O'Lovelace" }] });
    });

    const planned = await planChatSend(graph(), CHAT, { text: 'hi', mentions: ['ada.lovelace@contoso.com'] });
    expect(filter).toBe("mail eq 'ada.lovelace@contoso.com'");
    expect(planned.body.mentions?.[0]?.mentioned.user.id).toBe('u-alias');
  });

  it('refuses an empty message before making any request', async () => {
    await expect(planChatSend(graph(), CHAT, { text: '', mentions: ['ada@example.test'] })).rejects.toThrow(
      ConfigError,
    );
    expect(server.requests).toHaveLength(0);
  });
});
