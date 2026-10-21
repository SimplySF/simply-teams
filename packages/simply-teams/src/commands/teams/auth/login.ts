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

import { authStatus, type AuthStatus, READ_SCOPES } from '@simplysf/simply-teams-core';
import { renderAuthStatus } from '../../../shared/auth-output.js';
import { TeamsCommand } from '../../../shared/base-command.js';

export default class AuthLogin extends TeamsCommand<typeof AuthLogin> {
  public static override interactiveSignIn = true;

  public static override readonly summary = 'Sign in through the operating system, confirming once if asked.';
  public static override readonly description =
    'Signs in as the account the operating system is signed in with, through its identity broker ' +
    '(Web Account Manager on Windows). Usually nothing appears at all. When the broker needs ' +
    'you, for first-time consent or a Conditional Access check, it shows its own account picker; ' +
    'on a machine joined to Entra ID that is one click, never a password.\n\n' +
    'Nothing is stored by this CLI: the broker keeps the session, so every later command and the ' +
    'MCP server sign in silently. Run this again only when one of them says to.';

  public static override readonly examples = ['<%= config.bin %> <%= command.id %>'];

  public async run(): Promise<AuthStatus> {
    const config = this.teamsConfig();
    // Every read scope at once, so the broker asks for consent at this one moment rather than
    // as each command first needs a scope — which, for an agent, would be mid-task.
    await this.tokens(config).getToken({ scopes: READ_SCOPES });
    const status = await authStatus(config, this.tokens(config), this.graph(config));
    this.logSafe(`Signed in.\n\n${renderAuthStatus(status)}`);
    return status;
  }
}
