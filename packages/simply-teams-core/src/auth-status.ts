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

import type { TeamsCloud, TeamsConfig } from './config.js';
import { AuthError } from './errors.js';
import type { GraphClient } from './graph-client.js';
import {
  ADMIN_CONSENT_SCOPES,
  BASE_SCOPES,
  missingScopes,
  shortScope,
  type TokenProvider,
  type TokenSource,
  USER_CONSENT_SCOPES,
  WRITE_SCOPES,
} from './token.js';

/**
 * What `teams auth status` and `teams auth login` report. Everything about the token except the
 * token itself: this object is printed, returned to agents, and may be pasted into a ticket.
 */
export interface AuthStatus {
  readonly account?: string;
  readonly displayName?: string;
  readonly tenantId?: string;
  readonly cloud: TeamsCloud;
  readonly source: TokenSource;
  readonly clientId?: string;
  readonly expiresOn?: string;
  readonly scopes: readonly string[];
  /** Read scopes the token lacks. Search needs `Chat.Read` and `ChannelMessage.Read.All` both. */
  readonly missingScopes: readonly string[];
  /**
   * Write scopes the token lacks (design 0004). Reported apart from `missingScopes` because writes
   * are opt-in: a read-only sign-in is the normal, healthy state, not a gap.
   */
  readonly missingWriteScopes: readonly string[];
}

/**
 * Gets a token, then proves it works by asking Graph who it belongs to. The round trip is the
 * point: a token can be issued and still be refused, by Conditional Access or a disabled
 * account, and a status that only looked at the token would report that case as healthy.
 *
 * Asks only for `User.Read`, which any user can consent to, so status still works — and can say
 * what is missing — in exactly the situation it is most needed: before an admin has consented
 * to the rest. The broker's token lists every consented scope regardless of what was asked for.
 */
export async function authStatus(config: TeamsConfig, tokens: TokenProvider, graph: GraphClient): Promise<AuthStatus> {
  const token = await tokens.getToken({ scopes: BASE_SCOPES });
  const me = await graph.me();
  const scopes = token.scopes.map(shortScope);
  return {
    account: me.userPrincipalName ?? token.account,
    displayName: me.displayName,
    tenantId: token.tenantId,
    cloud: config.cloud,
    source: token.source,
    clientId: token.source === 'broker' ? config.clientId : undefined,
    expiresOn: token.expiresOn?.toISOString(),
    scopes,
    missingScopes: missingScopes(scopes),
    missingWriteScopes: missingScopes(scopes, WRITE_SCOPES),
  };
}

/** What `auth login` reports: the status, plus where an administrator can grant what is missing. */
export interface SignInResult extends AuthStatus {
  /** Present only when an admin-only scope is missing and the app and tenant are both known. */
  readonly adminConsentUrl?: string;
}

/** The tenant-wide admin-consent page for this app registration, or nothing if it cannot be named. */
export function adminConsentUrl(config: TeamsConfig, tenantId: string | undefined): string | undefined {
  if (config.clientId === undefined || tenantId === undefined || tenantId === '') return undefined;
  // A multi-tenant alias would send the administrator to their own home tenant, not this one.
  if (tenantId === 'organizations' || tenantId === 'common') return undefined;
  return `${config.endpoints.loginUrl}/${encodeURIComponent(tenantId)}/adminconsent?client_id=${encodeURIComponent(config.clientId)}`;
}

/** What `auth login` was asked to cover beyond the read scopes. */
export interface SignInOptions {
  /** Also ask for the write scopes (design 0004). Both are user-consentable, so this may prompt. */
  readonly writes?: boolean;
}

/**
 * Signs in in two steps (design 0003): interactively for the scopes a user can grant, then
 * silently for the admin-only ones. A missing admin consent is reported, not fatal, so the
 * commands that never needed an administrator work from the first login. With `writes`, the
 * write scopes are asked for too, interactively, since a user can grant them (design 0004).
 */
export async function signIn(
  config: TeamsConfig,
  tokens: TokenProvider,
  graph: GraphClient,
  options: SignInOptions = {},
): Promise<SignInResult> {
  await tokens.getToken({ scopes: USER_CONSENT_SCOPES });
  if (options.writes === true) await tokens.getToken({ scopes: WRITE_SCOPES });
  try {
    await tokens.getToken({ scopes: ADMIN_CONSENT_SCOPES, silentOnly: true });
  } catch (error) {
    // A prompt here could only say "Need admin approval"; the status below reports the gap.
    if (!(error instanceof AuthError)) throw error;
  }
  const status = await authStatus(config, tokens, graph);
  const lacksAdmin = ADMIN_CONSENT_SCOPES.some((scope) => status.missingScopes.includes(scope));
  const url =
    lacksAdmin && status.source === 'broker' ? adminConsentUrl(config, status.tenantId ?? config.tenantId) : undefined;
  return url === undefined ? status : { ...status, adminConsentUrl: url };
}
