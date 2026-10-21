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
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamsMcpInstall from '../src/commands/teams/mcp/install.js';

/**
 * The client knowledge is tested in test/mcpClients. These pin what this command adds:
 * which flags reach the server's args, the default name, the launcher guard, and the exit code.
 * Every case writes a project-scope file under a temp working directory, never a real profile.
 */

let cwd: string;

// Only the environment the library plans against moves to the temp directory; oclif's own
// process.cwd() lookups (finding this package's package.json) stay where they are.
vi.mock('../src/mcpClients/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcpClients/index.js')>();
  return { ...actual, currentEnvironment: () => ({ ...actual.currentEnvironment(), cwd }) };
});

// oclif holds its own reference to process.stdout, so the command's log/warn/logJson calls are
// intercepted directly rather than the streams.
type Output = {
  log: (message?: string) => void;
  warn: (message: string | Error) => void;
  logJson: (json: unknown) => void;
};
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-mcp-install-'));
  stdout = [];
  stderr = [];
  const prototype = TeamsMcpInstall.prototype as unknown as Output;
  vi.spyOn(prototype, 'log').mockImplementation((message?: string) => stdout.push(message ?? ''));
  vi.spyOn(prototype, 'logJson').mockImplementation((json: unknown) => stdout.push(JSON.stringify(json)));
  vi.spyOn(prototype, 'warn').mockImplementation((message: string | Error) => stderr.push(String(message)));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(cwd, { recursive: true, force: true });
});

const vscodeFile = (): string => path.join(cwd, '.vscode', 'mcp.json');
const servers = (): Record<string, { command: string; args: string[] }> =>
  (
    JSON.parse(fs.readFileSync(vscodeFile(), 'utf8')) as {
      servers: Record<string, { command: string; args: string[] }>;
    }
  ).servers;

describe('teams mcp install', () => {
  it('fails with exit 2 and lists the client ids when --client is missing', async () => {
    await expect(TeamsMcpInstall.run([])).rejects.toMatchObject({
      oclif: { exit: 2 },
      message: expect.stringMatching(/--client[\s\S]*claude-desktop[\s\S]*codex/) as unknown,
    });
  });

  it('writes the read-only server under simply-teams, launched through simply at project scope', async () => {
    const envFile = path.join(cwd, 'teams.env');
    fs.writeFileSync(envFile, 'TEAMS_CLIENT_ID=11111111-2222-3333-4444-555555555555');

    const result = await TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--env-file', 'teams.env']);

    expect(result.results).toMatchObject([{ client: 'vscode', outcome: 'added' }]);
    expect(servers()).toStrictEqual({
      'simply-teams': { type: 'stdio', command: 'simply', args: ['teams', 'mcp', '--env-file', envFile] },
    });
    expect(stdout.join('')).toContain('VS Code: added "simply-teams"');
    expect(process.exitCode).toBe(0);
  });

  it('forwards --allow-writes, and names the entry simply-teams-write', async () => {
    await TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--allow-writes']);

    expect(servers()['simply-teams-write'].args).toStrictEqual(['teams', 'mcp', '--allow-writes']);
  });

  it('honors --name and --launcher npx', async () => {
    await TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--name', 'gl', '--launcher', 'npx']);

    expect(servers().gl).toMatchObject({ command: 'npx', args: ['-y', '@simplysf/simply-cli', 'teams', 'mcp'] });
  });

  it('warns on stderr when there is no --env-file', async () => {
    await TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project']);
    expect(stderr.join('')).toMatch(/No --env-file given/);
  });

  it('refuses an --env-file that does not exist, writing nothing', async () => {
    await expect(
      TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--env-file', 'missing.env']),
    ).rejects.toMatchObject({ oclif: { exit: 2 } });
    expect(fs.existsSync(vscodeFile())).toBe(false);
  });

  it('refuses the absolute launcher when not running under the simply CLI', async () => {
    await expect(
      TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--launcher', 'absolute']),
    ).rejects.toMatchObject({
      oclif: { exit: 2 },
      message: expect.stringMatching(/--launcher simply/) as unknown,
    });
  });

  it('changes nothing on --dry-run and returns the plan as JSON', async () => {
    await TeamsMcpInstall.run(['--client', 'vscode', '--scope', 'project', '--dry-run', '--json']);

    expect(fs.existsSync(vscodeFile())).toBe(false);
    expect(JSON.parse(stdout.at(-1) ?? '')).toMatchObject({
      dryRun: true,
      results: [{ client: 'vscode', outcome: 'added', dryRun: true }],
    });
  });

  it('exits 2 when any client conflicts or is refused, after attempting every client', async () => {
    fs.mkdirSync(path.dirname(vscodeFile()));
    fs.writeFileSync(vscodeFile(), JSON.stringify({ servers: { 'simply-teams': { command: 'other' } } }));

    const result = await TeamsMcpInstall.run([
      '--client',
      'vscode',
      '--client',
      'claude-desktop',
      '--client',
      'cursor',
      '--scope',
      'project',
    ]);

    expect(result.results.map((entry) => entry.outcome)).toStrictEqual(['conflict', 'failed', 'added']);
    expect(process.exitCode).toBe(2);
  });
});
