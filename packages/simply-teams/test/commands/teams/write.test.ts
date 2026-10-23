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

import process from 'node:process';
import { Command } from '@oclif/core';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelPost from '../../../src/commands/teams/channel/post.js';
import ChatSend from '../../../src/commands/teams/chat/send.js';
import MessageReply from '../../../src/commands/teams/message/reply.js';

const GRAPH = 'https://graph.microsoft.com';
const CHAT = '19:chat@thread.v2';
const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:general@thread.tacv2';
const TOKEN = 'opaque-test-token-value';
const CHANNEL_MESSAGES = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;

function posted(id: string, html: string, where: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    messageType: 'message',
    createdDateTime: '2026-10-22T14:03:00Z',
    from: { user: { id: 'u', displayName: 'Ada' } },
    body: { contentType: 'html', content: html },
    ...where,
  };
}

let stdout: string[];

beforeEach(() => {
  nock.disableNetConnect();
  process.env.TEAMS_ACCESS_TOKEN = TOKEN;
  stdout = [];
  vi.spyOn(Command.prototype, 'log').mockImplementation((message?: string) => {
    stdout.push(`${message ?? ''}\n`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.TEAMS_ACCESS_TOKEN;
  delete process.env.TEAMS_READ_ONLY;
});

function exitOf(error: unknown): number | undefined {
  return (error as { oclif?: { exit?: number } }).oclif?.exit;
}

describe('teams channel post', () => {
  it('posts the escaped text and returns the stored message in the read shape', async () => {
    let sent: unknown;
    nock(GRAPH)
      .post(CHANNEL_MESSAGES, (body) => {
        sent = body;
        return true;
      })
      .reply(201, posted('7', '<p>hi &lt;all&gt;</p>', { channelIdentity: { teamId: TEAM, channelId: CHANNEL } }));

    const result = await ChannelPost.run([`${TEAM}/${CHANNEL}`, '--text', 'hi <all>']);

    expect(sent).toStrictEqual({ body: { contentType: 'html', content: 'hi &lt;all&gt;' } });
    expect(result).toMatchObject({ ref: `${TEAM}/${CHANNEL}/7`, text: 'hi <all>' });
    expect(stdout.join('')).toContain('Posted as Ada.');
    expect(stdout.join('')).not.toContain(TOKEN);
  });

  it('sends nothing under --dry-run and returns the request', async () => {
    const result = await ChannelPost.run([`${TEAM}/${CHANNEL}`, '--text', 'draft', '--dry-run']);
    expect(result).toMatchObject({ method: 'POST', path: CHANNEL_MESSAGES.replace('/v1.0', '') });
    expect(stdout.join('')).toContain('Dry run: nothing was sent.');
    expect(nock.pendingMocks()).toStrictEqual([]);
  });

  it('is refused under TEAMS_READ_ONLY before any request, with exit code 2', async () => {
    process.env.TEAMS_READ_ONLY = '1';
    const error = await ChannelPost.run([`${TEAM}/${CHANNEL}`, '--text', 'x']).catch((caught: unknown) => caught);
    expect(exitOf(error)).toBe(2);
  });

  it('exits 3 on a 403, naming the scope and the login that asks for it', async () => {
    nock(GRAPH)
      .post(CHANNEL_MESSAGES)
      .reply(403, { error: { code: 'Forbidden', message: 'Missing scope permissions on the request.' } });
    const error = await ChannelPost.run([`${TEAM}/${CHANNEL}`, '--text', 'x']).catch((caught: unknown) => caught);
    expect(exitOf(error)).toBe(3);
    expect((error as Error).message).toMatch(/ChannelMessage\.Send.*auth login --allow-writes/);
  });

  it('is not retried after a 502, which may have followed a posted message', async () => {
    nock(GRAPH)
      .post(CHANNEL_MESSAGES)
      .reply(502, { error: { code: 'BadGateway' } });
    const error = await ChannelPost.run([`${TEAM}/${CHANNEL}`, '--text', 'x']).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('may have been posted');
    expect(nock.pendingMocks()).toStrictEqual([]);
  });
});

describe('teams message reply', () => {
  it('replies to the thread a reply belongs to', async () => {
    nock(GRAPH)
      .post(`${CHANNEL_MESSAGES}/100/replies`)
      .reply(
        201,
        posted('106', '<p>agreed</p>', { replyToId: '100', channelIdentity: { teamId: TEAM, channelId: CHANNEL } }),
      );

    const result = await MessageReply.run([`${TEAM}/${CHANNEL}/100/105`, '--text', 'agreed']);
    expect(result).toMatchObject({ ref: `${TEAM}/${CHANNEL}/100/106`, replyToId: '100' });
  });

  it('exits 2 for a chat message, pointing at chat send', async () => {
    const error = await MessageReply.run([`${CHAT}/42`, '--text', 'x']).catch((caught: unknown) => caught);
    expect(exitOf(error)).toBe(2);
    expect((error as Error).message).toMatch(/chats have no threads.*teams chat send/);
  });
});

describe('teams chat send', () => {
  it('sends to the chat, with a mention resolved first', async () => {
    let sent: unknown;
    nock(GRAPH)
      .get('/v1.0/users/ada%40contoso.com')
      .query(true)
      .reply(200, { id: 'u-ada', displayName: 'Ada' })
      .post(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages`, (body) => {
        sent = body;
        return true;
      })
      .reply(201, posted('9', '<p><at id="0">Ada</at> thanks</p>', { chatId: CHAT }));

    const result = await ChatSend.run([CHAT, '--text', 'thanks', '--mention', 'ada@contoso.com']);

    expect(sent).toMatchObject({
      body: { contentType: 'html', content: '<at id="0">Ada</at> thanks' },
      mentions: [{ id: 0, mentionText: 'Ada', mentioned: { user: { id: 'u-ada' } } }],
    });
    expect(result).toMatchObject({ ref: `${CHAT}/9`, text: '@Ada thanks' });
  });

  it('exits 2 on an empty message without a request', async () => {
    const error = await ChatSend.run([CHAT, '--text', ' ']).catch((caught: unknown) => caught);
    expect(exitOf(error)).toBe(2);
  });
});
