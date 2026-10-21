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
import { resolveTeamsConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const CLIENT = '11111111-2222-3333-4444-555555555555';

describe('resolveTeamsConfig', () => {
  it('defaults to the global cloud and the signed-in account’s home tenant', () => {
    expect(resolveTeamsConfig({}, { TEAMS_CLIENT_ID: CLIENT })).toStrictEqual({
      cloud: 'global',
      endpoints: { loginUrl: 'https://login.microsoftonline.com', graphUrl: 'https://graph.microsoft.com' },
      tenantId: 'organizations',
      clientId: CLIENT,
      accessToken: undefined,
      interactive: true,
    });
  });

  it('lets flags beat the environment', () => {
    const config = resolveTeamsConfig(
      { clientId: CLIENT, tenantId: 'contoso.com', cloud: 'usgov-high' },
      { TEAMS_CLIENT_ID: '99999999-2222-3333-4444-555555555555', TEAMS_TENANT_ID: 'other.com', TEAMS_CLOUD: 'global' },
    );
    expect(config.clientId).toBe(CLIENT);
    expect(config.tenantId).toBe('contoso.com');
    expect(config.endpoints.graphUrl).toBe('https://graph.microsoft.us');
  });

  it('maps DoD to its own Graph host', () => {
    expect(resolveTeamsConfig({ cloud: 'DOD' }, { TEAMS_CLIENT_ID: CLIENT }).endpoints).toStrictEqual({
      loginUrl: 'https://login.microsoftonline.us',
      graphUrl: 'https://dod-graph.microsoft.us',
    });
  });

  it('names the variable when no client ID is configured', () => {
    expect(() => resolveTeamsConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveTeamsConfig({}, {})).toThrow(/TEAMS_CLIENT_ID/);
  });

  it('needs no client ID when a token is supplied', () => {
    const config = resolveTeamsConfig({}, { TEAMS_ACCESS_TOKEN: 'eyJ.x.y' });
    expect(config.clientId).toBeUndefined();
    expect(config.accessToken).toBe('eyJ.x.y');
  });

  it.each(['not-a-guid', 'https://portal.azure.com/app'])('rejects a client ID that is not a GUID: %s', (value) => {
    expect(() => resolveTeamsConfig({}, { TEAMS_CLIENT_ID: value })).toThrow(/GUID/);
  });

  it('rejects an unknown cloud, naming the choices and where GCC belongs', () => {
    expect(() => resolveTeamsConfig({}, { TEAMS_CLIENT_ID: CLIENT, TEAMS_CLOUD: 'gcc' })).toThrow(
      /global, usgov-high, dod.*GCC Moderate tenants use global/,
    );
  });

  it('rejects a tenant that is neither a GUID nor a domain', () => {
    expect(() => resolveTeamsConfig({ tenantId: 'not a tenant' }, { TEAMS_CLIENT_ID: CLIENT })).toThrow(ConfigError);
  });

  it('lets the environment take interaction away, but never force it on', () => {
    const env = { TEAMS_CLIENT_ID: CLIENT, TEAMS_NO_INTERACTIVE: 'true' };
    expect(resolveTeamsConfig({ interactive: true }, env).interactive).toBe(false);
    expect(resolveTeamsConfig({ interactive: false }, { TEAMS_CLIENT_ID: CLIENT }).interactive).toBe(false);
  });
});
