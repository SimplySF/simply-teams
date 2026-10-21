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

import { Command, Flags } from '@oclif/core';
import { selectTools, startServer } from '../../index.js';

/**
 * Serves this package's MCP tools over stdio, as a command of the `simply` CLI.
 *
 * The same server the `simply-teams-mcp` binary runs — that binary still exists and still works.
 * This exists so an MCP client can be pointed at `simply` with no separate global install: the
 * plugin is fetched on first use like any other.
 *
 * **Extends `Command` directly, not `TeamsCommand`.** That is deliberate and load-bearing. stdout
 * is the protocol channel here, and the shared base class enables oclif's `--json` flag, which
 * makes oclif print this command's return value to stdout when it is passed. One stray object on
 * that stream corrupts the session, and the client's error would say nothing about why.
 */
export default class TeamsMcp extends Command {
  // Explicitly off, restating the class comment as code so a later refactor onto a base class
  // that enables it fails loudly here rather than silently corrupting a protocol stream.
  public static override enableJsonFlag = false;

  public static override readonly summary = 'Serve the Teams MCP tools over stdio.';
  public static override readonly description =
    'Runs a Model Context Protocol server exposing Microsoft Teams as tools, for Claude Desktop, Claude ' +
    'Code, Cursor, Gemini CLI, VS Code, or any other MCP client. It speaks the protocol on stdout, ' +
    'so it is meant to be launched by a client rather than run by hand — at a terminal it will ' +
    'simply appear to hang, waiting for a client that is not there.\n\n' +
    'Point a client at it with "command": "simply", "args": ["teams", "mcp"]. The plugin installs ' +
    'itself on first use, so nothing needs installing beyond the simply CLI.\n\n' +
    'Only read tools are registered unless --allow-writes is passed, and TEAMS_READ_ONLY still ' +
    'refuses every write even then.';

  public static override readonly examples = [
    {
      description: 'Register only the read tools, taking settings from the environment',
      command: '<%= config.bin %> <%= command.id %>',
    },
    {
      description: 'Allow writes, with settings from a file',
      command: '<%= config.bin %> <%= command.id %> --allow-writes --env-file ~/teams.env',
    },
    {
      description: 'List the tools this server would register, without starting it',
      command: '<%= config.bin %> <%= command.id %> --list',
    },
  ];

  public static override readonly flags = {
    'allow-writes': Flags.boolean({
      summary: 'Also register the tools that change data.',
      description:
        'Off by default, so a server launched without thinking about it can only read. ' +
        'TEAMS_READ_ONLY in the environment still refuses every write even when this is on.',
      default: false,
    }),
    'env-file': Flags.string({
      char: 'e',
      summary: 'Path to a .env file holding connection settings.',
      description:
        'Use an absolute path. MCP clients launch a server from a working directory of their own, ' +
        'so ~ and relative paths may not resolve.',
    }),
    list: Flags.boolean({
      summary: 'Print the tools that would be registered, then exit without serving.',
      description: 'Printed to stderr, because stdout belongs to the protocol.',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(TeamsMcp);

    if (flags.list) {
      // stderr, like every other diagnostic here: a client that inspects stdout must only ever
      // find protocol traffic on it.
      const tools = selectTools(flags['allow-writes']);
      process.stderr.write(
        [
          `${tools.length} tool(s) would be registered${flags['allow-writes'] ? ' (writes allowed)' : ' (read-only)'}:`,
          ...tools.map((tool) => `  ${tool.name.padEnd(28)} ${tool.title}`),
          '',
        ].join('\n'),
      );
      return;
    }

    // Resolves once the transport is connected; the process then stays alive until the client
    // closes the stream, which is why this command never returns in normal use.
    await startServer({ allowWrites: flags['allow-writes'], envFile: flags['env-file'] });
  }
}
