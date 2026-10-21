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
import { authStatus } from '../src/auth-status.js';
import { resolveTeamsConfig, type TeamsConfig } from '../src/config.js';
import { GraphClient } from '../src/graph-client.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { AccessToken, TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;
const config: TeamsConfig = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: '11111111-2222-3333-4444-555555555555' });

function fixedTokens(token: Partial<AccessToken> = {}): TokenProvider & { requests: TokenRequest[] } {
  const requests: TokenRequest[] = [];
  return {
    requests,
    getToken: (request = {}) => {
      requests.push(request);
      return Promise.resolve({ token: 'secret-token', source: 'broker', scopes: [], ...token });
    },
  };
}

function client(tokens: TokenProvider = fixedTokens()): GraphClient {
  return new GraphClient(config, tokens, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe('GraphClient.list', () => {
  /** Three pages of two, linked the way Graph links them: a full URL carrying a skip token. */
  function routePages(): void {
    server.route('/v1.0/me/chats', (req, res) => {
      const skip = new URL(req.url ?? '', server.baseUrl).searchParams.get('$skiptoken');
      const page = skip === null ? 0 : Number(skip);
      respondJson(res, 200, {
        value: [page * 2 + 1, page * 2 + 2],
        ...(page < 2 ? { '@odata.nextLink': `${server.baseUrl}/v1.0/me/chats?$skiptoken=${page + 1}` } : {}),
      });
    });
  }

  it('follows nextLink to the end and reports the list complete', async () => {
    routePages();
    const result = await client().list<number>('/me/chats', { scopes: ['Chat.Read'], limit: 50, query: { $top: 2 } });

    expect(result).toStrictEqual({ items: [1, 2, 3, 4, 5, 6], pages: 3, complete: true });
    // The query rides on the first request only; the next link already carries it.
    expect(server.requests.map((request) => request.url)).toStrictEqual([
      '/v1.0/me/chats?%24top=2',
      '/v1.0/me/chats?$skiptoken=1',
      '/v1.0/me/chats?$skiptoken=2',
    ]);
  });

  it('stops at the limit and says more are available', async () => {
    routePages();
    const result = await client().list<number>('/me/chats', { scopes: ['Chat.Read'], limit: 3 });

    expect(result).toStrictEqual({ items: [1, 2, 3], pages: 2, complete: false });
  });

  it('asks for the scopes the endpoint needs on every page', async () => {
    routePages();
    const tokens = fixedTokens();
    await client(tokens).list('/me/chats', { scopes: ['Chat.Read'], limit: 50 });

    expect(tokens.requests.map((request) => request.scopes)).toStrictEqual([
      ['Chat.Read'],
      ['Chat.Read'],
      ['Chat.Read'],
    ]);
  });
});

describe('authStatus', () => {
  it('reports the account Graph confirms, the missing scopes, and never the token', async () => {
    server.route('/v1.0/me', (_req, res) => {
      respondJson(res, 200, { id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@contoso.com' });
    });
    const tokens = fixedTokens({
      tenantId: 'tid',
      expiresOn: new Date('2026-10-21T13:00:00Z'),
      scopes: ['https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Chat.ReadWrite', 'openid'],
    });

    const status = await authStatus(config, tokens, client(tokens));

    expect(status).toStrictEqual({
      account: 'ada@contoso.com',
      displayName: 'Ada',
      tenantId: 'tid',
      cloud: 'global',
      source: 'broker',
      clientId: config.clientId,
      expiresOn: '2026-10-21T13:00:00.000Z',
      scopes: ['User.Read', 'Chat.ReadWrite', 'openid'],
      missingScopes: ['User.ReadBasic.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'],
    });
    expect(JSON.stringify(status)).not.toContain('secret-token');
  });

  it('asks only for User.Read, so it works before an admin has consented to the rest', async () => {
    server.route('/v1.0/me', (_req, res) => respondJson(res, 200, { id: 'u1' }));
    const tokens = fixedTokens();

    await authStatus(config, tokens, client(tokens));

    expect(tokens.requests.map((request) => request.scopes)).toStrictEqual([['User.Read'], ['User.Read']]);
  });
});
