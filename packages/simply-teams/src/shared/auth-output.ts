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

import { type AuthStatus, formatKeyValue } from '@simplysf/simply-teams-core';

/** The human rendering `auth login` and `auth status` share, so the two read the same. */
export function renderAuthStatus(status: AuthStatus): string {
  const lines = [
    formatKeyValue([
      ['Account', status.account],
      ['Name', status.displayName],
      ['Tenant', status.tenantId],
      ['Cloud', status.cloud],
      ['Signed in via', status.source === 'broker' ? 'operating system (broker)' : 'TEAMS_ACCESS_TOKEN'],
      ['Client ID', status.clientId],
      ['Token expires', status.expiresOn],
      ['Missing scopes', status.missingScopes.length === 0 ? 'none' : status.missingScopes.join(', ')],
    ]),
  ];
  if (status.missingScopes.includes('ChannelMessage.Read.All')) {
    lines.push(
      '',
      'Message search needs ChannelMessage.Read.All, which only a tenant administrator can consent to ' +
        'for this app registration. Graph refuses chat search too until it is granted.',
    );
  }
  return lines.join('\n');
}
