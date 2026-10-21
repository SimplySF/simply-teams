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

import path from 'node:path';
import { Command, Flags } from '@oclif/core';
import {
  buildLaunch,
  CLIENT_IDS,
  currentEnvironment,
  defaultLauncher,
  detectInstalledClients,
  exitCodeFor,
  formatClientChoices,
  formatInstallReport,
  installServer,
  resolveEnvFile,
  SIMPLY_CLI_PACKAGE,
  type InstallResult,
} from '../../../mcpClients/index.js';

export type TeamsMcpInstallResult = { dryRun: boolean; results: InstallResult[] };

/**
 * Writes an entry for `simply teams mcp` into named MCP clients. Knowledge of the clients lives
 * in `src/mcpClients`; this command only says what the server is and which of its flags to forward.
 * See docs/design/0010-mcp-install.md.
 *
 * Unlike `teams mcp`, this command is not a protocol server, so `--json` is safe here.
 */
export default class TeamsMcpInstall extends Command {
  public static override enableJsonFlag = true;

  public static override readonly summary = 'Add the Teams MCP server to MCP clients.';
  public static override readonly description =
    'Writes an entry that launches "simply teams mcp" into each client named with --client, ' +
    'keeping the rest of that client’s configuration as it was. Claude Code and Codex are changed ' +
    'through their own CLIs; every other client’s JSON file is edited in place, with a .bak copy kept.\n\n' +
    'Credentials are never written. Give the server its connection settings with --env-file, which is ' +
    'written as an absolute path and must exist now. A GUI client will not pass on your shell’s ' +
    'environment, so without --env-file the entry starts with no settings.\n\n' +
    'Running it again is safe: an identical entry is left alone, and a different one is only replaced ' +
    'with --force.';

  public static override readonly examples = [
    {
      description: 'Add the read-only server to Claude Code and Cursor',
      command: '<%= config.bin %> <%= command.id %> --client claude-code --client cursor --env-file ~/teams.env',
    },
    {
      description: 'Add a second, write-enabled entry (named simply-teams-write) to Claude Desktop',
      command:
        '<%= config.bin %> <%= command.id %> --client claude-desktop --allow-writes --env-file ~/teams-write.env',
    },
    {
      description: 'Commit an entry for this repository’s VS Code users',
      command: '<%= config.bin %> <%= command.id %> --client vscode --scope project',
    },
    {
      description: 'See what would be written, and change nothing',
      command: '<%= config.bin %> <%= command.id %> --client gemini --dry-run',
    },
  ];

  public static override readonly flags = {
    client: Flags.option({
      options: CLIENT_IDS,
      multiple: true,
      summary: 'Client to add the server to. Repeat for several.',
    })(),
    scope: Flags.option({
      options: ['user', 'project'] as const,
      default: 'user' as const,
      summary: 'Your own configuration, or the repository-level file in the current directory.',
    })(),
    'env-file': Flags.string({
      char: 'e',
      summary: 'Connection settings file for the server. Written as an absolute path.',
    }),
    'allow-writes': Flags.boolean({
      summary: 'Register the tools that change data. Also makes the default name simply-teams-write.',
      default: false,
    }),
    name: Flags.string({
      summary: 'Entry name. Default simply-teams, or simply-teams-write with --allow-writes.',
    }),
    launcher: Flags.option({
      options: ['absolute', 'simply', 'npx'] as const,
      summary: 'How the entry starts simply. Default absolute for --scope user, simply for --scope project.',
      description:
        'absolute: this Node binary and the simply CLI’s own script, which works for GUI clients that do ' +
        'not see your PATH (re-run with --force after a Node upgrade moves it). simply: "simply" on PATH, ' +
        'right for a committed file. npx: "npx -y @simplysf/simply-cli", for machines without a global install.',
    })(),
    force: Flags.boolean({ summary: 'Replace an existing entry of the same name that differs.', default: false }),
    'dry-run': Flags.boolean({ summary: 'Show what would be written, and change nothing.', default: false }),
  };

  public async run(): Promise<TeamsMcpInstallResult> {
    const { flags } = await this.parse(TeamsMcpInstall);
    const environment = currentEnvironment();

    if (!flags.client?.length) {
      this.error(formatClientChoices(await detectInstalledClients(environment)), { exit: 2 });
    }

    const launcher = flags.launcher ?? defaultLauncher(flags.scope);
    if (launcher === 'absolute' && this.config.pjson.name !== SIMPLY_CLI_PACKAGE) {
      this.error(
        `--launcher absolute starts the simply CLI's own script, but this is running under ${this.config.pjson.name}. ` +
          'Run it as "simply teams mcp install", or pass --launcher simply or --launcher npx.',
        { exit: 2 },
      );
    }

    const simplyArgs = ['teams', 'mcp'];
    if (flags['allow-writes']) simplyArgs.push('--allow-writes');
    if (flags['env-file']) {
      const envFile = await resolveEnvFile(flags['env-file'], environment).catch((error: Error) =>
        this.error(error.message, { exit: 2 }),
      );
      simplyArgs.push('--env-file', envFile);
    } else {
      this.warn(
        'No --env-file given. The server will start with only the settings the client puts in the ' +
          'entry’s "env" block, and a GUI client does not pass on your shell’s environment.',
      );
    }

    const launch = buildLaunch(launcher, simplyArgs, {
      nodePath: process.execPath,
      runScript: path.join(this.config.root, 'bin', 'run.js'),
    });
    const name = flags.name ?? (flags['allow-writes'] ? 'simply-teams-write' : 'simply-teams');

    const results = await installServer({ name, ...launch }, flags.client, flags.scope, environment, {
      force: flags.force,
      dryRun: flags['dry-run'],
    });

    this.log(formatInstallReport(results, launcher));
    process.exitCode = exitCodeFor(results);
    return { dryRun: flags['dry-run'], results };
  }
}
