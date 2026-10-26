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
import { AuthError, CliError, HttpError } from '../src/errors.js';
import { HttpTransport, type TransportTarget } from '../src/http.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import type { TokenProvider, TokenRequest } from '../src/token.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

/** Hands out `token-1`, `token-2`, … and records what each request asked for. */
function countingTokens(): TokenProvider & { requests: TokenRequest[] } {
  const requests: TokenRequest[] = [];
  return {
    requests,
    getToken: (request = {}) => {
      requests.push(request);
      return Promise.resolve({ token: `token-${requests.length}`, source: 'environment', scopes: [] });
    },
  };
}

function transport(overrides: Partial<TransportTarget> = {}): HttpTransport {
  return new HttpTransport({ baseUrl: `${server.baseUrl}/v1.0`, tokens: countingTokens(), ...overrides });
}

describe('HttpTransport', () => {
  it('round-trips JSON under the base path and sends the bearer token', async () => {
    server.route('/v1.0/echo', (req, res, body) => {
      respondJson(res, 200, {
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        received: JSON.parse(body) as unknown,
      });
    });

    const result = await transport().json<{ authorization: string; contentType: string; received: unknown }>({
      method: 'POST',
      path: '/echo',
      body: { hello: 'world' },
    });

    expect(result).toStrictEqual({
      authorization: 'Bearer token-1',
      contentType: 'application/json',
      received: { hello: 'world' },
    });
  });

  it('reads a body as text under the asked-for Accept header, with the same token handling (design 0008)', async () => {
    server.route('/v1.0/vtt', (req, res) => {
      if (req.headers.authorization === 'Bearer token-1') {
        respondJson(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/vtt', 'x-accept': req.headers.accept ?? '' });
      res.end('WEBVTT\n\n{"not": "parsed"}');
    });

    const body = await transport().text({ method: 'GET', path: '/vtt', accept: 'text/vtt' });

    expect(body).toBe('WEBVTT\n\n{"not": "parsed"}');
    expect(server.requests.map((request) => request.url)).toStrictEqual(['/v1.0/vtt', '/v1.0/vtt']);
  });

  it('joins an array query value with commas, the way OData reads $select', async () => {
    server.route('/v1.0/me', (req, res) => {
      respondJson(res, 200, { url: req.url });
    });

    const result = await transport().json<{ url: string }>({
      method: 'GET',
      path: '/me',
      query: { $select: ['id', 'displayName'], $top: 5, skipped: undefined },
    });

    expect(decodeURIComponent(result.url)).toBe('/v1.0/me?$select=id,displayName&$top=5');
  });

  it('passes the scopes a call names to the token provider', async () => {
    server.route('/v1.0/me', (_req, res) => respondJson(res, 200, {}));
    const tokens = countingTokens();

    await transport({ tokens }).json({ method: 'GET', path: '/me', scopes: ['User.Read'] });

    expect(tokens.requests).toStrictEqual([{ forceRefresh: false, scopes: ['User.Read'] }]);
  });

  it('follows an absolute URL on the same origin, for @odata.nextLink', async () => {
    server.route('/v1.0/next', (_req, res) => respondJson(res, 200, { ok: true }));

    await expect(
      transport().json({ method: 'GET', path: `${server.baseUrl}/v1.0/next?$skiptoken=abc` }),
    ).resolves.toStrictEqual({ ok: true });
  });

  it('refuses to send the token to any other origin', async () => {
    await expect(transport().json({ method: 'GET', path: 'https://attacker.example/v1.0/next' })).rejects.toThrow(
      CliError,
    );
    expect(server.requests).toHaveLength(0);
  });

  it('answers a 401 with exactly one forced token refresh, then succeeds', async () => {
    server.route('/v1.0/me', (req, res) => {
      if (req.headers.authorization === 'Bearer token-1') respondJson(res, 401, {});
      else respondJson(res, 200, { id: 'me' });
    });
    const tokens = countingTokens();

    await expect(transport({ tokens }).json({ method: 'GET', path: '/me' })).resolves.toStrictEqual({ id: 'me' });
    expect(tokens.requests.map((request) => request.forceRefresh)).toStrictEqual([false, true]);
  });

  it('raises AuthError when the refreshed token is refused too', async () => {
    server.route('/v1.0/me', (_req, res) => {
      respondJson(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } });
    });

    const error = await transport()
      .json({ method: 'GET', path: '/me' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/InvalidAuthenticationToken: Access token has expired\./);
    expect(server.requests).toHaveLength(2);
  });

  it("raises AuthError on a 403 without retrying, quoting Graph's own explanation", async () => {
    server.route('/v1.0/search/query', (_req, res) => {
      respondJson(res, 403, {
        error: { code: 'Forbidden', message: 'Access to ChatMessage in Graph API requires ChannelMessage.Read.All.' },
      });
    });

    const error = await transport()
      .json({ method: 'POST', path: '/search/query', body: {} })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).status).toBe(403);
    expect((error as AuthError).message).toMatch(/Forbidden: Access to ChatMessage .* ChannelMessage\.Read\.All/);
    expect(server.requests).toHaveLength(1);
  });

  it('retries a 503 and then succeeds', async () => {
    let calls = 0;
    server.route('/v1.0/flaky', (_req, res) => {
      calls += 1;
      if (calls === 1) respondJson(res, 503, {}, { 'retry-after': '0' });
      else respondJson(res, 200, { ok: true });
    });

    await expect(transport().json({ method: 'GET', path: '/flaky' })).resolves.toStrictEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries a 500 and gives up as HttpError', async () => {
    server.route('/v1.0/broken', (_req, res) => {
      respondJson(res, 500, { error: { code: 'UnknownError', message: '' } });
    });

    await expect(transport({ maxAttempts: 2 }).json({ method: 'GET', path: '/broken' })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(server.requests).toHaveLength(2);
  });

  it('collapses a multi-line error body onto one line', async () => {
    // A newline here would forge extra stderr lines a caller parses line-by-line.
    server.route('/v1.0/messy', (_req, res) => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('first\nsecond');
    });

    await expect(transport().json({ method: 'GET', path: '/messy' })).rejects.toThrow(/first second/);
  });

  it('does not follow a redirect, which would carry the token with it', async () => {
    server.route('/v1.0/moved', (_req, res) => {
      res.writeHead(302, { location: 'https://attacker.example/' });
      res.end();
    });

    await expect(transport({ maxAttempts: 1 }).json({ method: 'GET', path: '/moved' })).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });
});

describe('writes (design 0004)', () => {
  /*
   * A gateway can return a 5xx, or drop the connection, after Graph has already posted the
   * message. Graph messages have no idempotency key, so a retry would post it twice, in front of
   * everyone in the channel. A write retries only what proves Graph did not act.
   */
  it('sends a write once on a 5xx, and says the message may have been posted', async () => {
    server.route('/v1.0/teams/t/channels/c/messages', (_req, res) => {
      respondJson(res, 502, { error: { code: 'BadGateway', message: 'upstream' } }, { 'retry-after': '0' });
    });

    const error = await transport()
      .json({ method: 'POST', path: '/teams/t/channels/c/messages', body: {}, mutating: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).toContain('may have been posted');
    expect(server.requests).toHaveLength(1);
  });

  it('still retries a write on a 429, which Graph refuses before acting', async () => {
    let calls = 0;
    server.route('/v1.0/chats/x/messages', (_req, res) => {
      calls += 1;
      if (calls === 1) respondJson(res, 429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '0' });
      else respondJson(res, 201, { id: '1' });
    });

    await expect(
      transport().json({ method: 'POST', path: '/chats/x/messages', body: {}, mutating: true }),
    ).resolves.toEqual({ id: '1' });
    expect(calls).toBe(2);
  });

  it('does not retry a write when the connection drops mid-request', async () => {
    server.route('/v1.0/chats/x/messages', (_req, res) => {
      res.socket?.destroy();
    });

    const error = await transport()
      .json({ method: 'POST', path: '/chats/x/messages', body: {}, mutating: true })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('may have been posted');
    expect(server.requests).toHaveLength(1);
  });

  it('says a write that timed out may have been posted', async () => {
    server.route('/v1.0/chats/x/messages', () => {
      // Never respond.
    });

    const error = await transport({ timeoutMs: 100, maxAttempts: 1 })
      .json({ method: 'POST', path: '/chats/x/messages', body: {}, mutating: true })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('may have been posted');
  });

  it('refreshes the token once on a 401 and sends the write, since Graph acted on nothing', async () => {
    let calls = 0;
    server.route('/v1.0/chats/x/messages', (_req, res) => {
      calls += 1;
      if (calls === 1) respondJson(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
      else respondJson(res, 201, { id: '2' });
    });

    await expect(
      transport().json({ method: 'POST', path: '/chats/x/messages', body: {}, mutating: true }),
    ).resolves.toEqual({ id: '2' });
    expect(calls).toBe(2);
  });

  it('does not say a write may have been posted when getting the token failed, since nothing was sent', async () => {
    const broken: TokenProvider = { getToken: () => Promise.reject(new Error('broker unavailable')) };
    const error = await transport({ tokens: broken, maxAttempts: 1 })
      .json({ method: 'POST', path: '/chats/x/messages', body: {}, mutating: true })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('broker unavailable');
    expect((error as Error).message).not.toContain('may have been posted');
    expect(server.requests).toHaveLength(0);
  });

  it('keeps retrying a 5xx on a POST that reads, such as search', async () => {
    let calls = 0;
    server.route('/v1.0/search/query', (_req, res) => {
      calls += 1;
      if (calls === 1) respondJson(res, 503, {}, { 'retry-after': '0' });
      else respondJson(res, 200, { value: [] });
    });

    await expect(transport().json({ method: 'POST', path: '/search/query', body: {} })).resolves.toEqual({ value: [] });
    expect(calls).toBe(2);
  });
});
