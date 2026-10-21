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
import ChannelList from '../../../src/commands/teams/channel/list.js';
import ChatMessages from '../../../src/commands/teams/chat/messages.js';
import MessageSearch from '../../../src/commands/teams/message/search.js';
import MessageViewCommand from '../../../src/commands/teams/message/view.js';

const GRAPH = 'https://graph.microsoft.com';
const CHAT = '19:chat@thread.v2';
const TEAM = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'opaque-test-token-value';

function raw(id: string, html: string): Record<string, unknown> {
  return {
    id,
    messageType: 'message',
    chatId: CHAT,
    createdDateTime: '2026-10-21T14:03:00Z',
    from: { user: { id: 'u', displayName: 'Ada' } },
    body: { contentType: 'html', content: html },
  };
}

let stdout: string[];

beforeEach(() => {
  nock.disableNetConnect();
  process.env.TEAMS_ACCESS_TOKEN = TOKEN;
  stdout = [];
  // Everything the commands print goes through Command.log (logSafe included).
  vi.spyOn(Command.prototype, 'log').mockImplementation((message?: string) => {
    stdout.push(`${message ?? ''}
`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.TEAMS_ACCESS_TOKEN;
});

describe('teams chat messages', () => {
  it('prints a transcript, oldest first, with message markup rendered and control characters stripped', async () => {
    nock(GRAPH)
      .get(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages`)
      .query(true)
      .reply(200, {
        value: [raw('2', '<p>then <b>this</b>\u001b[2J</p>'), raw('1', '<p>first <at id="0">Bo</at></p>')],
      });

    const result = await ChatMessages.run([CHAT]);

    expect(result.items.map((item) => item.id)).toStrictEqual(['1', '2']);
    const output = stdout.join('');
    expect(output).toMatch(/── Ada · .*\nfirst @Bo\n\n── Ada · .*\nthen \*\*this\*\*\[2J/);
    expect(output).not.toContain('\u001b');
    expect(output).toMatch(/Showing 2 messages\./);
  });
});

describe('teams message view', () => {
  it('accepts a pasted Teams link', async () => {
    const link = `https://teams.microsoft.com/l/message/${encodeURIComponent(CHAT)}/42?context=%7b%22contextType%22%3a%22chat%22%7d`;
    nock(GRAPH)
      .get(`/v1.0/chats/${encodeURIComponent(CHAT)}/messages/42`)
      .reply(200, raw('42', '<p>the answer</p>'));

    const view = await MessageViewCommand.run([link, '--json']);

    expect(view.message).toMatchObject({ ref: `${CHAT}/42`, text: 'the answer' });
  });

  it('exits 2 naming what it wanted when given a chat instead of a message', async () => {
    const error = await MessageViewCommand.run([CHAT]).catch((caught: unknown) => caught);
    expect((error as { oclif?: { exit?: number } }).oclif?.exit).toBe(2);
    expect((error as Error).message).toMatch(/That is a chat, but this needs a chat message or a channel message/);
  });
});

describe('teams message search', () => {
  it('compiles the flags into KQL and returns refs that message view accepts', async () => {
    let sent: unknown;
    nock(GRAPH)
      .post('/v1.0/search/query', (body: unknown) => {
        sent = body;
        return true;
      })
      .reply(200, {
        value: [
          {
            hitsContainers: [
              {
                hits: [{ summary: '<c0>freeze</c0>', resource: { id: '7', chatId: CHAT } }],
                moreResultsAvailable: false,
              },
            ],
          },
        ],
      });

    const result = await MessageSearch.run(['freeze', '--from', 'Ada Lovelace', '--json']);

    expect(sent).toMatchObject({
      requests: [{ entityTypes: ['chatMessage'], query: { queryString: 'freeze from:"Ada Lovelace"' } }],
    });
    expect(result.items).toMatchObject([{ ref: `${CHAT}/7`, summary: '**freeze**' }]);
  });

  it("passes Graph's missing-consent refusal through as an auth failure", async () => {
    nock(GRAPH)
      .post('/v1.0/search/query')
      .reply(403, {
        error: { code: 'Forbidden', message: 'Access to ChatMessage in Graph API requires ChannelMessage.Read.All' },
      });

    const error = await MessageSearch.run(['x']).catch((caught: unknown) => caught);

    expect((error as { oclif?: { exit?: number } }).oclif?.exit).toBe(3);
    expect((error as Error).message).toMatch(/ChannelMessage\.Read\.All/);
  });
});

describe('teams channel list', () => {
  it('finds the team by name and prints channel refs', async () => {
    nock(GRAPH)
      .get('/v1.0/me/joinedTeams')
      .reply(200, { value: [{ id: TEAM, displayName: 'Platform' }] });
    nock(GRAPH)
      .get(`/v1.0/teams/${TEAM}/channels`)
      .reply(200, { value: [{ id: '19:gen@thread.tacv2', displayName: 'General', membershipType: 'standard' }] });

    const result = await ChannelList.run(['Platform']);

    expect(result.items).toMatchObject([{ ref: `${TEAM}/19:gen@thread.tacv2`, name: 'General' }]);
    expect(stdout.join('')).toContain(`${TEAM}/19:gen@thread.tacv2`);
  });
});
