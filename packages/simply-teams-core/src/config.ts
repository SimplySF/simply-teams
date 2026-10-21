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
import { ConfigError } from './errors.js';

/** The Microsoft clouds this CLI can sign in to and call. GCC Moderate runs on `global`. */
export type TeamsCloud = 'global' | 'usgov-high' | 'dod';

/** Where one cloud's sign-in and Graph endpoints live. */
export interface CloudEndpoints {
  /** Entra ID authority host, without a tenant segment. */
  readonly loginUrl: string;
  /** Microsoft Graph origin; also the resource prefix of every scope requested from it. */
  readonly graphUrl: string;
}

export const CLOUDS: Readonly<Record<TeamsCloud, CloudEndpoints>> = {
  global: { loginUrl: 'https://login.microsoftonline.com', graphUrl: 'https://graph.microsoft.com' },
  'usgov-high': { loginUrl: 'https://login.microsoftonline.us', graphUrl: 'https://graph.microsoft.us' },
  dod: { loginUrl: 'https://login.microsoftonline.us', graphUrl: 'https://dod-graph.microsoft.us' },
};

export interface TeamsConfig {
  readonly cloud: TeamsCloud;
  readonly endpoints: CloudEndpoints;
  /** Authority tenant: a GUID, a verified domain, or `organizations` for the account's home tenant. */
  readonly tenantId: string;
  /**
   * The Entra app registration tokens are issued to. Absent only when `accessToken` is set,
   * because a supplied token was already issued to some app and nothing is requested.
   */
  readonly clientId?: string;
  /** A Graph access token to use as-is, skipping the broker (design 0001, step 1). */
  readonly accessToken?: string;
  /** Whether a sign-in window may be opened when the broker cannot sign in silently. */
  readonly interactive: boolean;
}

/** Per-invocation overrides, sourced from global flags. Anything set here beats the environment. */
export interface ConfigOverrides {
  readonly clientId?: string;
  readonly tenantId?: string;
  readonly cloud?: string;
  /**
   * Whether the caller may prompt at all. The MCP server passes `false` unconditionally, since a
   * sign-in window opened from a windowless stdio child lands behind the IDE mid-tool-call.
   */
  readonly interactive?: boolean;
}

export type EnvLike = Record<string, string | undefined>;

export const CLIENT_ID_ENV = 'TEAMS_CLIENT_ID';
export const TENANT_ID_ENV = 'TEAMS_TENANT_ID';
export const CLOUD_ENV = 'TEAMS_CLOUD';
export const ACCESS_TOKEN_ENV = 'TEAMS_ACCESS_TOKEN';
export const NO_INTERACTIVE_ENV = 'TEAMS_NO_INTERACTIVE';

/** Lets the broker pick the home tenant of the account the operating system is signed in with. */
export const DEFAULT_TENANT = 'organizations';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** An Entra application (client) ID is always a GUID; anything else is a paste mistake. */
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** A tenant is a GUID, a domain, or one of the multi-tenant aliases Entra ID accepts. */
const TENANT =
  /^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[a-z\d.-]+\.[a-z]{2,}|organizations|common)$/i;

function isCloud(value: string): value is TeamsCloud {
  return Object.hasOwn(CLOUDS, value);
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/**
 * Resolves where and as whom to sign in. Unlike the sibling CLIs there is no credential to
 * require here: the operating system's broker supplies the identity, so the only mandatory
 * setting is which app registration to ask it on behalf of.
 */
export function resolveTeamsConfig(overrides: ConfigOverrides = {}, env: EnvLike = process.env): TeamsConfig {
  const rawCloud = (trimmed(overrides.cloud) ?? trimmed(env[CLOUD_ENV]) ?? 'global').toLowerCase();
  if (!isCloud(rawCloud)) {
    throw new ConfigError(
      `${CLOUD_ENV}=${rawCloud} is not a cloud this CLI knows. Use one of: ${Object.keys(CLOUDS).join(', ')}. ` +
        'GCC Moderate tenants use global.',
    );
  }

  const tenantId = trimmed(overrides.tenantId) ?? trimmed(env[TENANT_ID_ENV]) ?? DEFAULT_TENANT;
  if (!TENANT.test(tenantId)) {
    throw new ConfigError(`Tenant "${tenantId}" is not a GUID or a domain (${TENANT_ID_ENV}).`);
  }

  const accessToken = trimmed(env[ACCESS_TOKEN_ENV]);
  const clientId = trimmed(overrides.clientId) ?? trimmed(env[CLIENT_ID_ENV]);
  if (clientId !== undefined && !GUID.test(clientId)) {
    throw new ConfigError(`${CLIENT_ID_ENV} must be an application (client) ID, a GUID; got "${clientId}".`);
  }
  if (clientId === undefined && accessToken === undefined) {
    throw new ConfigError(
      `Signing in needs the application (client) ID of an Entra app registration. Set ${CLIENT_ID_ENV} ` +
        `or pass --client-id. Alternatively set ${ACCESS_TOKEN_ENV} to a Microsoft Graph access token.`,
    );
  }

  const envInteractive = !TRUTHY.has((env[NO_INTERACTIVE_ENV] ?? '').trim().toLowerCase());
  return {
    cloud: rawCloud,
    endpoints: CLOUDS[rawCloud],
    tenantId,
    clientId,
    accessToken,
    // The environment can only take interaction away; a caller cannot be forced to prompt.
    interactive: (overrides.interactive ?? true) && envInteractive,
  };
}
