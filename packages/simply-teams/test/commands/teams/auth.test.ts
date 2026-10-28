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
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AuthLogin from '../../../src/commands/teams/auth/login.js';
import AuthStatusCommand from '../../../src/commands/teams/auth/status.js';

const GRAPH = 'https://graph.microsoft.com';

/** An unsigned JWT; the CLI reads its claims for display and leaves verification to Graph. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

const TOKEN = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  upn: 'ada@contoso.com',
  tid: 'tid',
  scp: 'User.Read Chat.Read',
});

/** Captures what a command writes to stderr, which is where every failure goes. */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  return { text: () => chunks.join(''), restore: () => (process.stderr.write = original) };
}

beforeEach(() => {
  nock.disableNetConnect();
  process.env.TEAMS_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.TEAMS_ACCESS_TOKEN;
  delete process.env.TEAMS_CLIENT_ID;
});

describe('teams auth status', () => {
  it('confirms the account with Graph and reports what is missing, never the token', async () => {
    const me = nock(GRAPH, { reqheaders: { authorization: `Bearer ${TOKEN}` } })
      .get('/v1.0/me')
      .query(true)
      .reply(200, { id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@contoso.com' });

    const status = await AuthStatusCommand.run(['--json']);

    expect(me.isDone()).toBe(true);
    expect(status).toMatchObject({
      account: 'ada@contoso.com',
      displayName: 'Ada',
      tenantId: 'tid',
      source: 'environment',
      missingScopes: [
        'User.ReadBasic.All',
        'Team.ReadBasic.All',
        'Channel.ReadBasic.All',
        'OnlineMeetings.Read',
        'ChannelMessage.Read.All',
        'OnlineMeetingTranscript.Read.All',
      ],
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('exits 3 with one JSON line on stderr when Graph refuses the token', async () => {
    nock(GRAPH)
      .get('/v1.0/me')
      .query(true)
      .times(2)
      .reply(401, { error: { code: 'InvalidAuthenticationToken' } });
    const stderr = captureStderr();

    const error = await AuthStatusCommand.run(['--json']).catch((caught: unknown) => caught);
    stderr.restore();

    expect((error as { oclif?: { exit?: number } }).oclif?.exit).toBe(3);
    // Under vitest, oclif also warns about its own plugin lookup on stderr; take our line only.
    const ours = stderr
      .text()
      .split('\n')
      .find((text) => text.startsWith('{"error"'));
    const line = JSON.parse(ours ?? '') as { error: { name: string; exitCode: number } };
    expect(line.error).toMatchObject({ name: 'AuthError', exitCode: 3 });
    expect(stderr.text()).not.toContain(TOKEN);
  });

  it('exits 2 naming TEAMS_CLIENT_ID when there is nothing to sign in with', async () => {
    delete process.env.TEAMS_ACCESS_TOKEN;
    const stderr = captureStderr();

    const error = await AuthStatusCommand.run(['--json']).catch((caught: unknown) => caught);
    stderr.restore();

    expect((error as { oclif?: { exit?: number } }).oclif?.exit).toBe(2);
    expect(stderr.text()).toMatch(/TEAMS_CLIENT_ID/);
  });
});

describe('sign-in prompts', () => {
  it('are allowed for auth login only', () => {
    // Every other command must fail with a pointer to login rather than open a window mid-task.
    expect(AuthLogin.interactiveSignIn).toBe(true);
    expect(AuthStatusCommand.interactiveSignIn).toBe(false);
  });
});
