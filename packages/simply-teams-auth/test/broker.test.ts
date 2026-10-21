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

import type { AuthenticationResult, InteractiveRequest } from '@azure/msal-node';
import { AuthError, ConfigError, resolveTeamsConfig, type TeamsConfig } from '@simplysf/simply-teams-core';
import { describe, expect, it } from 'vitest';
import { BrokerTokenProvider, brokerWasLoaded, type BrokerClient, createTokenProvider } from '../src/index.js';

const CLIENT = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-10-21T12:00:00Z');

function config(env: Record<string, string> = {}, interactive = true): TeamsConfig {
  return resolveTeamsConfig({ interactive }, { TEAMS_CLIENT_ID: CLIENT, ...env });
}

function result(overrides: Partial<AuthenticationResult> = {}): AuthenticationResult {
  return {
    authority: 'https://login.microsoftonline.com/organizations',
    uniqueId: 'oid',
    tenantId: 'tid',
    scopes: ['https://graph.microsoft.com/User.Read'],
    account: {
      homeAccountId: 'h',
      environment: 'e',
      tenantId: 'tid',
      username: 'ada@contoso.com',
      localAccountId: 'l',
    },
    idToken: '',
    idTokenClaims: {},
    accessToken: 'access-token',
    fromCache: false,
    expiresOn: new Date(NOW.getTime() + 3_600_000),
    tokenType: 'Bearer',
    correlationId: 'c',
    ...overrides,
  };
}

/** An MSAL error shaped the way the broker plugin raises one. */
function msalError(errorCode: string, errorMessage: string): Error {
  return Object.assign(new Error(errorMessage), { errorCode, errorMessage });
}

/** A scripted MSAL client: each call takes the next answer and is recorded. */
function fakeClient(...answers: Array<AuthenticationResult | Error>): BrokerClient & { calls: InteractiveRequest[] } {
  const calls: InteractiveRequest[] = [];
  return {
    calls,
    acquireTokenInteractive: (request) => {
      calls.push(request);
      const answer = answers.shift() ?? new Error('no scripted answer left');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

function provider(
  client: BrokerClient,
  teamsConfig: TeamsConfig = config(),
  now = (): Date => NOW,
): BrokerTokenProvider {
  return new BrokerTokenProvider(teamsConfig, { createClient: () => Promise.resolve(client), now });
}

describe('BrokerTokenProvider', () => {
  it('signs in silently as the operating-system account, asking for User.Read by default', async () => {
    const client = fakeClient(result());

    const token = await provider(client).getToken();

    expect(token).toMatchObject({
      token: 'access-token',
      source: 'broker',
      account: 'ada@contoso.com',
      tenantId: 'tid',
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ prompt: 'none', scopes: ['https://graph.microsoft.com/User.Read'] });
  });

  it('asks for the scopes a call names, qualified for the configured cloud', async () => {
    const client = fakeClient(result());

    await provider(client, config({ TEAMS_CLOUD: 'usgov-high' })).getToken({ scopes: ['Chat.Read'] });

    expect(client.calls[0]?.scopes).toStrictEqual(['https://graph.microsoft.us/Chat.Read']);
  });

  it('reuses a cached token per scope set until it nears expiry', async () => {
    const client = fakeClient(result(), result({ accessToken: 'second' }), result({ accessToken: 'third' }));
    let now = NOW;
    const tokens = provider(client, config(), () => now);

    await tokens.getToken({ scopes: ['Chat.Read', 'User.Read'] });
    // Same set in a different order: still the cached token.
    expect((await tokens.getToken({ scopes: ['User.Read', 'Chat.Read'] })).token).toBe('access-token');
    // A different set is its own request.
    expect((await tokens.getToken({ scopes: ['User.Read'] })).token).toBe('second');
    // Inside the five-minute margin, the cached token is not trusted to survive the request.
    now = new Date(NOW.getTime() + 56 * 60_000);
    expect((await tokens.getToken({ scopes: ['User.Read', 'Chat.Read'] })).token).toBe('third');
  });

  it('bypasses the cache when the caller forces a refresh', async () => {
    const client = fakeClient(result(), result({ accessToken: 'fresh' }));
    const tokens = provider(client);

    await tokens.getToken();
    expect((await tokens.getToken({ forceRefresh: true })).token).toBe('fresh');
  });

  it('falls back to the broker’s own prompt when interaction is allowed', async () => {
    const client = fakeClient(msalError('interaction_required', 'InteractionRequired: (pii)'), result());

    await expect(provider(client).getToken()).resolves.toMatchObject({ token: 'access-token' });
    expect(client.calls.map((call) => call.prompt)).toStrictEqual(['none', undefined]);
  });

  it('never prompts when interaction is not allowed, and says how to sign in instead', async () => {
    const client = fakeClient(msalError('interaction_required', 'InteractionRequired: (pii)'));

    const error = await provider(client, config({}, false))
      .getToken()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/simply teams auth login/);
    expect(client.calls).toHaveLength(1);
  });

  it('reports any other broker failure as an AuthError, first line only', async () => {
    const client = fakeClient(msalError('network_error', 'The network is down\nstack and noise'));

    await expect(provider(client).getToken()).rejects.toThrow(/^Sign-in failed: network_error: The network is down$/);
  });

  it('never offers MSAL a usable browser fallback', async () => {
    const client = fakeClient(result());
    await provider(client).getToken();

    await expect(client.calls[0]?.openBrowser?.('https://login.example')).rejects.toBeInstanceOf(ConfigError);
  });

  it('requires a client ID', () => {
    expect(() => new BrokerTokenProvider({ ...config(), clientId: undefined })).toThrow(/TEAMS_CLIENT_ID/);
  });
});

describe('createTokenProvider', () => {
  it('prefers a supplied TEAMS_ACCESS_TOKEN over the broker', async () => {
    const tokens = createTokenProvider(config({ TEAMS_ACCESS_TOKEN: 'opaque-token' }), {
      createClient: () => Promise.reject(new Error('the broker must not be touched')),
    });

    await expect(tokens.getToken()).resolves.toMatchObject({ token: 'opaque-token', source: 'environment' });
  });

  it('does not load the native broker until a token is asked for', () => {
    createTokenProvider(config());
    expect(brokerWasLoaded()).toBe(false);
  });
});
