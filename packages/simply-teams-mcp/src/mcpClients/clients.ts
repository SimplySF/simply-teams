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
import type { ClientId, InstallEnvironment, ServersKey } from './types.js';

/** Where a client keeps a JSON configuration file, and what it expects inside it. */
type FileLocation = {
  file: string;
  key: ServersKey;
  /** Add `"type": "stdio"` to the entry. */
  typed: boolean;
  clientDir?: string;
};

type ClientDefinition = {
  displayName: string;
  /** What to do after installing, since nothing here can tell whether the client noticed. */
  nextStep: string;
  /** User scope: a file to edit, or the client's own CLI. */
  user: (environment: InstallEnvironment) => FileLocation | { cli: 'claude' | 'codex'; configFile: string };
  /** Project scope, relative to `cwd`; absent where the client has no repo-level file. */
  project?: { file: string; key: ServersKey; typed: boolean };
};

/** `path` for the target platform, so Windows paths are built with `\` even when planned elsewhere. */
function pathFor(environment: InstallEnvironment): typeof path.posix {
  return environment.platform === 'win32' ? path.win32 : path.posix;
}

/** The per-user application data directory: `%APPDATA%`, `~/Library/Application Support`, or XDG. */
function appDataDir(environment: InstallEnvironment): string {
  const p = pathFor(environment);
  if (environment.platform === 'win32') {
    return environment.env.APPDATA ?? p.join(environment.homedir, 'AppData', 'Roaming');
  }
  if (environment.platform === 'darwin') return p.join(environment.homedir, 'Library', 'Application Support');
  return environment.env.XDG_CONFIG_HOME ?? p.join(environment.homedir, '.config');
}

function dotDirFile(environment: InstallEnvironment, dir: string[], file: string): FileLocation {
  const p = pathFor(environment);
  const clientDir = p.join(environment.homedir, ...dir);
  return { file: p.join(clientDir, file), key: 'mcpServers', typed: false, clientDir };
}

/**
 * The client table. A client that moves its file is a one-row change here, which is the reason this
 * lives in one package rather than in each product.
 */
export const CLIENTS: Readonly<Record<ClientId, ClientDefinition>> = {
  'claude-code': {
    displayName: 'Claude Code',
    nextStep: 'Run /mcp in Claude Code to check the server connects.',
    user: (environment) => ({
      cli: 'claude',
      configFile: pathFor(environment).join(environment.env.CLAUDE_CONFIG_DIR ?? environment.homedir, '.claude.json'),
    }),
    project: { file: '.mcp.json', key: 'mcpServers', typed: true },
  },
  'claude-desktop': {
    displayName: 'Claude Desktop',
    nextStep: 'Quit and restart Claude Desktop.',
    user: (environment) => {
      const clientDir = pathFor(environment).join(appDataDir(environment), 'Claude');
      return {
        file: pathFor(environment).join(clientDir, 'claude_desktop_config.json'),
        key: 'mcpServers',
        typed: false,
        clientDir,
      };
    },
  },
  cursor: {
    displayName: 'Cursor',
    nextStep: 'Check the server under Cursor Settings > MCP, and reload Cursor if it is not listed.',
    user: (environment) => dotDirFile(environment, ['.cursor'], 'mcp.json'),
    project: { file: path.posix.join('.cursor', 'mcp.json'), key: 'mcpServers', typed: false },
  },
  vscode: {
    displayName: 'VS Code',
    nextStep: 'Run "MCP: List Servers" in VS Code and start the server.',
    user: (environment) => {
      const p = pathFor(environment);
      const clientDir = p.join(appDataDir(environment), 'Code');
      return { file: p.join(clientDir, 'User', 'mcp.json'), key: 'servers', typed: true, clientDir };
    },
    project: { file: path.posix.join('.vscode', 'mcp.json'), key: 'servers', typed: true },
  },
  windsurf: {
    displayName: 'Windsurf',
    nextStep: "Refresh Windsurf's MCP servers, or restart Windsurf.",
    user: (environment) => dotDirFile(environment, ['.codeium', 'windsurf'], 'mcp_config.json'),
  },
  gemini: {
    displayName: 'Gemini CLI',
    nextStep: 'Run /mcp in Gemini CLI to check the server connects.',
    user: (environment) => dotDirFile(environment, ['.gemini'], 'settings.json'),
    project: { file: path.posix.join('.gemini', 'settings.json'), key: 'mcpServers', typed: false },
  },
  codex: {
    displayName: 'Codex CLI',
    nextStep: 'Start a new Codex session.',
    user: (environment) => ({
      cli: 'codex',
      configFile: pathFor(environment).join(
        environment.env.CODEX_HOME ?? pathFor(environment).join(environment.homedir, '.codex'),
        'config.toml',
      ),
    }),
  },
};

/** @returns The directory whose presence means the client is installed for this user. */
export function clientMarker(client: ClientId, environment: InstallEnvironment): string {
  const location = CLIENTS[client].user(environment);
  if ('cli' in location) {
    // Claude Code keeps `~/.claude/` (or `$CLAUDE_CONFIG_DIR`); Codex keeps `config.toml` in its home.
    return location.cli === 'claude'
      ? (environment.env.CLAUDE_CONFIG_DIR ?? pathFor(environment).join(environment.homedir, '.claude'))
      : pathFor(environment).dirname(location.configFile);
  }
  return location.clientDir ?? pathFor(environment).dirname(location.file);
}

export { pathFor };
