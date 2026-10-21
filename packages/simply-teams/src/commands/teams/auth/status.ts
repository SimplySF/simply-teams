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

import { authStatus, type AuthStatus } from '@simplysf/simply-teams-core';
import { renderAuthStatus } from '../../../shared/auth-output.js';
import { TeamsCommand } from '../../../shared/base-command.js';

export default class AuthStatusCommand extends TeamsCommand<typeof AuthStatusCommand> {
  public static override readonly summary = 'Show who you are signed in as, and which scopes are missing.';
  public static override readonly description =
    'Signs in silently as the account the operating system is signed in with, then asks Microsoft ' +
    'Graph who that is, so a token that is issued but refused (by Conditional Access, say) is ' +
    'reported as a failure rather than as healthy. Never opens a sign-in window: if one is needed, ' +
    'it fails with exit code 3 and says to run "simply teams auth login".\n\n' +
    'The token itself is never printed.';

  public static override readonly examples = [
    { description: 'Check the session', command: '<%= config.bin %> <%= command.id %>' },
    { description: 'Check it from a script', command: '<%= config.bin %> <%= command.id %> --json' },
  ];

  public async run(): Promise<AuthStatus> {
    const config = this.teamsConfig();
    const status = await authStatus(config, this.tokens(config), this.graph(config));
    this.logSafe(renderAuthStatus(status));
    return status;
  }
}
