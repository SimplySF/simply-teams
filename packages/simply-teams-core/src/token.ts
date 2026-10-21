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

import { ACCESS_TOKEN_ENV, type CloudEndpoints } from './config.js';
import { ConfigError } from './errors.js';

/** Where a token came from, so `auth status` can say which path is in use. */
export type TokenSource = 'broker' | 'environment';

/** A Graph access token plus what is known about it. Never rendered: only the metadata is. */
export interface AccessToken {
  readonly token: string;
  readonly source: TokenSource;
  readonly expiresOn?: Date;
  /** The signed-in user's UPN, when the token or the broker reports one. */
  readonly account?: string;
  readonly tenantId?: string;
  /** Short scope names (`Chat.Read`), whatever the token was actually granted. */
  readonly scopes: readonly string[];
}

export interface TokenRequest {
  /** Skip any cached token, after Graph has rejected the one it was given. */
  readonly forceRefresh?: boolean;
  /**
   * Short scope names this call needs; {@link BASE_SCOPES} when omitted. Each call asks only for
   * what it uses (incremental consent), so a missing admin-only scope breaks the commands that
   * need it rather than every command, `auth status` included. The broker's token still lists
   * every scope the user has consented to, whichever were asked for.
   */
  readonly scopes?: readonly string[];
}

/** What a call that names no scopes asks for: enough to read the signed-in user, which anyone can consent to. */
export const BASE_SCOPES = ['User.Read'] as const;

/**
 * Supplies Graph access tokens. Core depends on this interface only, so it stays free of MSAL
 * and its native broker binary; `@simplysf/simply-teams-auth` implements it against the
 * operating system's broker, and tests implement it with a fixed string.
 *
 * Asked per request rather than once per client, so a long-lived MCP server picks up a
 * refreshed token instead of failing an hour after it started.
 */
export interface TokenProvider {
  getToken(request?: TokenRequest): Promise<AccessToken>;
}

/**
 * The delegated scopes the read commands need between them (design 0001, Scopes). `auth login`
 * asks for all of them, so consent happens at one moment rather than one command at a time.
 * `ChannelMessage.Read.All` needs admin consent, and Graph refuses `chatMessage` search entirely
 * without it, even for chats.
 */
export const READ_SCOPES = [
  'User.Read',
  'User.ReadBasic.All',
  'Chat.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
] as const;

/**
 * Broader grants that cover a read scope, so a token holding the wider one is not reported
 * short. Deliberately conservative: reporting a scope missing when it would have worked costs a
 * confused look, while reporting it present when it is not hides the reason a call fails.
 * `ChannelMessage.Read.All` has no stand-in because the search API accepts nothing else for
 * channel messages: the design 0001 spike saw it refuse a token holding `Group.Read.All`.
 */
const SATISFIED_BY: Readonly<Record<string, readonly string[]>> = {
  'User.Read': ['User.ReadWrite'],
  'User.ReadBasic.All': ['User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All'],
  'Chat.Read': ['Chat.ReadWrite'],
  'Team.ReadBasic.All': ['TeamSettings.Read.All', 'TeamSettings.ReadWrite.All', 'Directory.Read.All'],
  'Channel.ReadBasic.All': ['ChannelSettings.Read.All', 'ChannelSettings.ReadWrite.All', 'Directory.Read.All'],
};

/** Fully qualified scopes for one cloud: Entra ID needs the Graph resource as the prefix. */
export function graphScopes(endpoints: CloudEndpoints, scopes: readonly string[] = READ_SCOPES): string[] {
  return scopes.map((scope) => `${endpoints.graphUrl}/${scope}`);
}

/** Strips the resource prefix Entra ID echoes back, so `https://graph.microsoft.com/Chat.Read` reads `Chat.Read`. */
export function shortScope(scope: string): string {
  const slash = scope.lastIndexOf('/');
  return slash === -1 ? scope : scope.slice(slash + 1);
}

/** Which of the read scopes a token lacks, allowing for broader grants that cover them. */
export function missingScopes(granted: readonly string[], wanted: readonly string[] = READ_SCOPES): string[] {
  const have = new Set(granted.map((scope) => shortScope(scope).toLowerCase()));
  return wanted.filter(
    (scope) => ![scope, ...(SATISFIED_BY[scope] ?? [])].some((candidate) => have.has(candidate.toLowerCase())),
  );
}

interface JwtClaims {
  readonly exp?: number;
  readonly scp?: string;
  readonly upn?: string;
  readonly unique_name?: string;
  readonly preferred_username?: string;
  readonly tid?: string;
}

/**
 * Reads a JWT's claims without verifying it. That is safe here because nothing is trusted on
 * the strength of these claims: Graph verifies the token, and they only feed `auth status` and
 * an early "this token has expired" message.
 */
function readClaims(token: string): JwtClaims | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return typeof claims === 'object' && claims !== null ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describes a token supplied through `TEAMS_ACCESS_TOKEN`. An expired one is refused up front:
 * Graph would refuse it anyway, but with a 401 that says nothing about where the token came from.
 */
export function describeStaticToken(token: string, now: Date = new Date()): AccessToken {
  const claims = readClaims(token);
  const expiresOn = claims?.exp === undefined ? undefined : new Date(claims.exp * 1000);
  if (expiresOn !== undefined && expiresOn.getTime() <= now.getTime()) {
    throw new ConfigError(
      `${ACCESS_TOKEN_ENV} expired at ${expiresOn.toISOString()}. Graph access tokens last about an hour; ` +
        `fetch a new one, or unset ${ACCESS_TOKEN_ENV} to sign in through the operating system instead.`,
    );
  }
  return {
    token,
    source: 'environment',
    expiresOn,
    account: claims?.upn ?? claims?.preferred_username ?? claims?.unique_name,
    tenantId: claims?.tid,
    scopes: (claims?.scp ?? '').split(' ').filter((scope) => scope !== ''),
  };
}

/** A provider that always answers with the same supplied token. */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    // Described per call rather than once, so a token that expires mid-session is caught.
    getToken: () => Promise.resolve(describeStaticToken(token)),
  };
}
