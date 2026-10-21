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

import { describe, expect, it } from 'vitest';
import { CLOUDS } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { describeStaticToken, graphScopes, missingScopes, READ_SCOPES, shortScope } from '../src/token.js';

/** An unsigned JWT carrying the given claims; nothing here verifies signatures. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

describe('scopes', () => {
  it('qualifies scopes with the Graph host of the cloud', () => {
    expect(graphScopes(CLOUDS['usgov-high'], ['Chat.Read'])).toStrictEqual(['https://graph.microsoft.us/Chat.Read']);
    expect(graphScopes(CLOUDS.global)).toHaveLength(READ_SCOPES.length);
  });

  it('strips the resource prefix Entra ID echoes back', () => {
    expect(shortScope('https://graph.microsoft.com/Chat.Read')).toBe('Chat.Read');
    expect(shortScope('openid')).toBe('openid');
  });

  it('counts a broader grant as covering a narrower scope', () => {
    expect(missingScopes(['Chat.ReadWrite'], ['Chat.Read'])).toStrictEqual([]);
    expect(missingScopes(['directory.read.all'], ['User.ReadBasic.All'])).toStrictEqual([]);
  });

  it('accepts nothing in place of ChannelMessage.Read.All, because search does not', () => {
    // The design 0001 spike: Graph refused chatMessage search for a token holding these.
    expect(
      missingScopes(['Chat.ReadWrite', 'Group.Read.All', 'Group.ReadWrite.All'], ['ChannelMessage.Read.All']),
    ).toStrictEqual(['ChannelMessage.Read.All']);
  });
});

describe('describeStaticToken', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('reads account, tenant, scopes, and expiry from the claims', () => {
    const token = jwt({ exp: now.getTime() / 1000 + 3600, upn: 'a@b.com', tid: 't', scp: 'User.Read Chat.Read' });
    expect(describeStaticToken(token, now)).toStrictEqual({
      token,
      source: 'environment',
      expiresOn: new Date(now.getTime() + 3_600_000),
      account: 'a@b.com',
      tenantId: 't',
      scopes: ['User.Read', 'Chat.Read'],
    });
  });

  it('refuses an expired token up front, naming where it came from', () => {
    const token = jwt({ exp: now.getTime() / 1000 - 1 });
    expect(() => describeStaticToken(token, now)).toThrow(ConfigError);
    expect(() => describeStaticToken(token, now)).toThrow(/TEAMS_ACCESS_TOKEN expired/);
  });

  it('passes an opaque token through, leaving Graph to judge it', () => {
    expect(describeStaticToken('not-a-jwt', now)).toMatchObject({
      token: 'not-a-jwt',
      scopes: [],
      expiresOn: undefined,
    });
  });
});
