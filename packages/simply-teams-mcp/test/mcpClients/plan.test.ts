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

import { describe, expect, it } from 'vitest';
import { planInstall } from '../../src/mcpClients/plan.js';
import type { ClientId, InstallEnvironment, InstallPlan, ServerSpec } from '../../src/mcpClients/types.js';

const spec: ServerSpec = { name: 'simply-atlassian', command: 'simply', args: ['atlassian', 'mcp'] };

const windows: InstallEnvironment = {
  platform: 'win32',
  homedir: 'C:\\Users\\me',
  cwd: 'C:\\repo',
  env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
};
const mac: InstallEnvironment = { platform: 'darwin', homedir: '/Users/me', cwd: '/repo', env: {} };
const linux: InstallEnvironment = { platform: 'linux', homedir: '/home/me', cwd: '/repo', env: {} };

function fileOf(plan: InstallPlan): string {
  if (plan.kind !== 'file') throw new Error(`expected a file plan, got ${plan.kind}`);
  return plan.file;
}

describe('planInstall: user-scope file per platform', () => {
  const cases: Array<[ClientId, InstallEnvironment, string]> = [
    ['claude-desktop', windows, 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json'],
    ['claude-desktop', mac, '/Users/me/Library/Application Support/Claude/claude_desktop_config.json'],
    ['claude-desktop', linux, '/home/me/.config/Claude/claude_desktop_config.json'],
    ['cursor', windows, 'C:\\Users\\me\\.cursor\\mcp.json'],
    ['cursor', mac, '/Users/me/.cursor/mcp.json'],
    ['vscode', windows, 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json'],
    ['vscode', mac, '/Users/me/Library/Application Support/Code/User/mcp.json'],
    ['vscode', linux, '/home/me/.config/Code/User/mcp.json'],
    ['windsurf', linux, '/home/me/.codeium/windsurf/mcp_config.json'],
    ['gemini', windows, 'C:\\Users\\me\\.gemini\\settings.json'],
  ];

  it.each(cases)('%s on %s', (client, environment, expected) => {
    expect(fileOf(planInstall(spec, client, 'user', environment))).toBe(expected);
  });

  it('honors XDG_CONFIG_HOME on Linux', () => {
    const plan = planInstall(spec, 'vscode', 'user', { ...linux, env: { XDG_CONFIG_HOME: '/xdg' } });
    expect(fileOf(plan)).toBe('/xdg/Code/User/mcp.json');
  });

  it('falls back to AppData\\Roaming when APPDATA is unset', () => {
    const plan = planInstall(spec, 'claude-desktop', 'user', { ...windows, env: {} });
    expect(fileOf(plan)).toBe('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });

  it('marks the client directory, so a missing client is not silently created', () => {
    const plan = planInstall(spec, 'cursor', 'user', mac);
    expect(plan).toMatchObject({ kind: 'file', clientDir: '/Users/me/.cursor' });
  });
});

describe('planInstall: entry shape', () => {
  it('writes mcpServers with a bare launch for most clients', () => {
    expect(planInstall(spec, 'cursor', 'user', mac)).toMatchObject({
      key: 'mcpServers',
      entry: { command: 'simply', args: ['atlassian', 'mcp'] },
    });
  });

  it('writes VS Code under servers with "type": "stdio"', () => {
    expect(planInstall(spec, 'vscode', 'user', mac)).toMatchObject({
      key: 'servers',
      entry: { type: 'stdio', command: 'simply', args: ['atlassian', 'mcp'] },
    });
  });

  it('does not share the caller’s args array', () => {
    const plan = planInstall(spec, 'cursor', 'user', mac);
    expect(plan.kind === 'file' && plan.entry.args).not.toBe(spec.args);
  });
});

describe('planInstall: project scope', () => {
  it.each([
    ['claude-code', '/repo/.mcp.json', 'mcpServers'],
    ['cursor', '/repo/.cursor/mcp.json', 'mcpServers'],
    ['vscode', '/repo/.vscode/mcp.json', 'servers'],
    ['gemini', '/repo/.gemini/settings.json', 'mcpServers'],
  ] as const)('%s writes %s', (client, file, key) => {
    const plan = planInstall(spec, client, 'project', linux);
    expect(plan).toMatchObject({ kind: 'file', file, key });
    expect(plan.kind === 'file' && plan.clientDir).toBeFalsy();
  });

  it('resolves against a Windows working directory', () => {
    expect(fileOf(planInstall(spec, 'vscode', 'project', windows))).toBe('C:\\repo\\.vscode\\mcp.json');
  });

  it.each(['claude-desktop', 'windsurf', 'codex'] as const)('refuses %s, which has no project file', (client) => {
    expect(planInstall(spec, client, 'project', linux)).toMatchObject({ kind: 'unsupported' });
  });
});

describe('planInstall: clients configured through their own CLI', () => {
  it('gives claude the entry as JSON at user scope', () => {
    const plan = planInstall(spec, 'claude-code', 'user', linux);
    expect(plan).toMatchObject({
      kind: 'cli',
      executable: 'claude',
      addArgs: [
        'mcp',
        'add-json',
        'simply-atlassian',
        '{"type":"stdio","command":"simply","args":["atlassian","mcp"]}',
        '--scope',
        'user',
      ],
      removeArgs: ['mcp', 'remove', 'simply-atlassian', '--scope', 'user'],
      configFile: '/home/me/.claude.json',
    });
  });

  it('reads Claude Code’s file from CLAUDE_CONFIG_DIR when set', () => {
    const plan = planInstall(spec, 'claude-code', 'user', { ...linux, env: { CLAUDE_CONFIG_DIR: '/cfg' } });
    expect(plan).toMatchObject({ configFile: '/cfg/.claude.json' });
  });

  it('gives codex the launch after --', () => {
    expect(planInstall(spec, 'codex', 'user', linux)).toMatchObject({
      kind: 'cli',
      executable: 'codex',
      addArgs: ['mcp', 'add', 'simply-atlassian', '--', 'simply', 'atlassian', 'mcp'],
      removeArgs: ['mcp', 'remove', 'simply-atlassian'],
      configFile: '/home/me/.codex/config.toml',
    });
  });

  it('honors CODEX_HOME', () => {
    const plan = planInstall(spec, 'codex', 'user', { ...linux, env: { CODEX_HOME: '/codex' } });
    expect(plan).toMatchObject({ configFile: '/codex/config.toml' });
  });
});

describe('planInstall: names', () => {
  it.each(['simply atlassian', 'a.b', '', 'ünïcode'])('refuses %j', (name) => {
    expect(planInstall({ ...spec, name }, 'cursor', 'user', linux)).toMatchObject({ kind: 'unsupported' });
  });
});
