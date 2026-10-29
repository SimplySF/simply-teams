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
import { GraphClient } from '../src/graph-client.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import { ROOT_SCAN_PAGES, ThreadRoots } from '../src/thread-root.js';
import type { TokenProvider } from '../src/token.js';

let server: TestServer;
const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';
const base = `/v1.0/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages`;

const config = resolveTeamsConfig({}, { TEAMS_CLIENT_ID: '00000000-0000-0000-0000-000000000001' });

function graph(): GraphClient {
  const tokens: TokenProvider = {
    getToken: () => Promise.resolve({ token: 't', source: 'broker', scopes: [] }),
  };
  return new GraphClient(config, tokens, { baseUrl: `${server.baseUrl}/v1.0`, maxAttempts: 1 });
}

/** A post with its replies expanded the way `$expand=replies` returns them; `more` cuts the list short. */
function post(id: string, replies: string[], more = false): Record<string, unknown> {
  return {
    id,
    replies: replies.map((reply) => ({ id: reply })),
    ...(more ? { 'replies@odata.nextLink': `${server.baseUrl}${base}/${id}/replies?$skiptoken=1` } : {}),
  };
}

/** Serves `pages` of posts, each linked to the next with nextLink the way Graph links them. */
function routePages(pages: Array<Array<Record<string, unknown>>>): void {
  server.route(base, (req, res) => {
    const index = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('$skiptoken') ?? '0');
    const last = index >= pages.length - 1;
    respondJson(res, 200, {
      value: pages[index] ?? [],
      ...(last ? {} : { '@odata.nextLink': `${server.baseUrl}${base}?$skiptoken=${index + 1}` }),
    });
  });
}

/** Requests that listed the channel's posts: the first carries the query, the rest follow nextLink. */
const scans = (): number => server.requests.filter((request) => request.url.startsWith(`${base}?`)).length;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe('ThreadRoots', () => {
  it('names a reply root from the newest posts, and a root as itself, reading the page once', async () => {
    routePages([[post('300', ['301', '302']), post('200', [])]]);
    const roots = new ThreadRoots(graph());
    expect(await roots.rootOf(TEAM, CHANNEL, '302')).toBe('300');
    expect(await roots.rootOf(TEAM, CHANNEL, '200')).toBe('200');
    expect(await roots.rootOf(TEAM, CHANNEL, '301')).toBe('300');
    expect(scans()).toBe(1);
    expect(server.requests[0]?.url).toContain('%24top=50');
  });

  it('reads further pages only when the first does not hold the message', async () => {
    routePages([[post('300', [])], [post('100', ['101'])], [post('50', [])]]);
    const roots = new ThreadRoots(graph());
    expect(await roots.rootOf(TEAM, CHANNEL, '300')).toBe('300');
    expect(scans()).toBe(1);
    expect(await roots.rootOf(TEAM, CHANNEL, '101')).toBe('100');
    expect(scans()).toBe(2);
  });

  it('gives up after the page ceiling, so a reply to an old thread is left unresolved', async () => {
    routePages(Array.from({ length: ROOT_SCAN_PAGES + 2 }, (_, index) => [post(String(900 - index), [])]));
    const roots = new ThreadRoots(graph());
    expect(await roots.rootOf(TEAM, CHANNEL, '1')).toBeUndefined();
    expect(scans()).toBe(ROOT_SCAN_PAGES);
    // Asked again, it does not read the channel again.
    expect(await roots.rootOf(TEAM, CHANNEL, '2')).toBeUndefined();
    expect(scans()).toBe(ROOT_SCAN_PAGES);
  });

  it('lists the replies of an older post whose expanded replies were cut short', async () => {
    routePages([[post('500', ['501'], true), post('100', ['101'], true)]]);
    server.route(`${base}/100/replies`, (_req, res) =>
      respondJson(res, 200, { value: [{ id: '150' }, { id: '101' }] }),
    );
    server.route(`${base}/500/replies`, (_req, res) => respondJson(res, 200, { value: [{ id: '501' }] }));
    const roots = new ThreadRoots(graph());
    expect(await roots.rootOf(TEAM, CHANNEL, '150')).toBe('100');
    // Post 500 is newer than message 150, so it was never a candidate and its replies were not read.
    expect(server.requests.some((request) => request.url.includes('/messages/500/replies'))).toBe(false);
  });

  it('resolves nothing, without failing, when the channel cannot be listed', async () => {
    server.route(base, (_req, res) => respondJson(res, 403, { error: { code: 'Forbidden' } }));
    const roots = new ThreadRoots(graph());
    expect(await roots.rootOf(TEAM, CHANNEL, '1')).toBeUndefined();
    expect(await roots.rootOf(TEAM, CHANNEL, '2')).toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });
});
