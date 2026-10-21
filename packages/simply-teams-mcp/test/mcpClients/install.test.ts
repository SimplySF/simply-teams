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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLaunch,
  defaultLauncher,
  detectInstalledClients,
  exitCodeFor,
  formatClientChoices,
  formatInstallReport,
  installServer,
  resolveEnvFile,
  type InstallEnvironment,
  type InstallResult,
} from '../../src/mcpClients/index.js';

let root: string;
let environment: InstallEnvironment;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'simply-mcp-install-'));
  const homedir = path.join(root, 'home');
  fs.mkdirSync(homedir);
  environment = {
    platform: process.platform,
    homedir,
    cwd: root,
    env: { APPDATA: path.join(homedir, 'AppData'), XDG_CONFIG_HOME: path.join(homedir, '.config') },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const spec = { name: 'simply-atlassian', command: 'simply', args: ['atlassian', 'mcp'] };

describe('installServer', () => {
  it('attempts every client, and the exit code is the highest any one contributes', async () => {
    fs.mkdirSync(path.join(environment.homedir, '.gemini'));

    const results = await installServer(spec, ['gemini', 'cursor', 'windsurf'], 'user', environment);

    expect(results.map((result) => [result.client, result.outcome])).toStrictEqual([
      ['gemini', 'added'],
      ['cursor', 'failed'],
      ['windsurf', 'failed'],
    ]);
    expect(exitCodeFor(results)).toBe(2);
  });

  it('installs each client once even if named twice', async () => {
    const results = await installServer(spec, ['vscode', 'vscode'], 'project', environment);
    expect(results).toHaveLength(1);
  });
});

describe('exitCodeFor', () => {
  const withCode = (exitCode: 0 | 1 | 2) => ({ exitCode }) as InstallResult;

  it('is 0 for nothing, and the highest otherwise', () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([withCode(0), withCode(1)])).toBe(1);
    expect(exitCodeFor([withCode(1), withCode(2), withCode(0)])).toBe(2);
  });
});

describe('detectInstalledClients', () => {
  it('lists the clients whose directory exists', async () => {
    fs.mkdirSync(path.join(environment.homedir, '.cursor'));
    fs.mkdirSync(path.join(environment.homedir, '.codex'));
    fs.mkdirSync(path.join(environment.homedir, '.claude'));

    expect(await detectInstalledClients(environment)).toStrictEqual(['claude-code', 'cursor', 'codex']);
  });
});

describe('buildLaunch', () => {
  const host = { nodePath: '/usr/bin/node', runScript: '/opt/simply/bin/run.js' };

  it('starts the host with this Node for absolute', () => {
    expect(buildLaunch('absolute', ['teams', 'mcp'], host)).toStrictEqual({
      command: '/usr/bin/node',
      args: ['/opt/simply/bin/run.js', 'teams', 'mcp'],
    });
  });

  it('relies on PATH for simply', () => {
    expect(buildLaunch('simply', ['teams', 'mcp'], host)).toStrictEqual({
      command: 'simply',
      args: ['teams', 'mcp'],
    });
  });

  it('fetches the host package for npx', () => {
    expect(buildLaunch('npx', ['teams', 'mcp'], host)).toStrictEqual({
      command: 'npx',
      args: ['-y', '@simplysf/simply-cli', 'teams', 'mcp'],
    });
  });

  it('defaults to absolute for user scope and simply for project scope', () => {
    expect(defaultLauncher('user')).toBe('absolute');
    expect(defaultLauncher('project')).toBe('simply');
  });
});

describe('resolveEnvFile', () => {
  it('expands ~ and resolves relative paths, returning an absolute path', async () => {
    fs.writeFileSync(path.join(environment.homedir, 'a.env'), 'X=1');
    fs.writeFileSync(path.join(root, 'b.env'), 'X=1');

    expect(await resolveEnvFile('~/a.env', environment)).toBe(path.join(environment.homedir, 'a.env'));
    expect(await resolveEnvFile('b.env', environment)).toBe(path.join(root, 'b.env'));
  });

  it('refuses a file that does not exist, naming the resolved path', async () => {
    await expect(resolveEnvFile('missing.env', environment)).rejects.toThrow(path.join(root, 'missing.env'));
  });

  it('refuses a directory', async () => {
    await expect(resolveEnvFile('home', environment)).rejects.toThrow(/not a file/);
  });
});

describe('formatInstallReport', () => {
  const result = (overrides: Partial<InstallResult>): InstallResult => ({
    client: 'claude-desktop',
    name: 'simply-teams',
    outcome: 'added',
    target: '/x/claude_desktop_config.json',
    dryRun: false,
    exitCode: 0,
    preview: '{ "preview": true }',
    ...overrides,
  });

  it('ends with the next step for each client that changed, and the Node note for absolute', () => {
    const text = formatInstallReport([result({}), result({ client: 'cursor', outcome: 'unchanged' })], 'absolute');

    expect(text).toContain('Claude Desktop: added "simply-teams"');
    expect(text).toContain('Cursor: already installed "simply-teams"');
    expect(text).toContain('Next:\n  Claude Desktop: Quit and restart Claude Desktop.');
    expect(text).not.toContain('  Cursor: Check');
    expect(text).toMatch(/run this command again with --force/);
  });

  it('shows the preview and no next steps on a dry run', () => {
    const text = formatInstallReport([result({ dryRun: true })], 'simply');

    expect(text).toContain('would add');
    expect(text).toContain('{ "preview": true }');
    expect(text).not.toContain('Next:');
  });

  it('includes a failure message', () => {
    expect(formatInstallReport([result({ outcome: 'conflict', message: 'Re-run with --force.' })])).toContain(
      '  Re-run with --force.',
    );
  });
});

describe('formatClientChoices', () => {
  it('lists every client and marks the installed ones', () => {
    const text = formatClientChoices(['cursor']);
    expect(text).toMatch(/cursor\s+Cursor \(found on this machine\)/);
    expect(text).toMatch(/codex\s+Codex CLI$/m);
  });
});
