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
import type { GraphClient } from './graph-client.js';
import { BASE_SCOPES, missingScopes, shortScope, type TokenProvider, type TokenSource } from './token.js';

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
  };
}
