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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPlan } from '../../src/mcpClients/apply.js';
import { planInstall } from '../../src/mcpClients/plan.js';
import type {
  ClientId,
  InstallEnvironment,
  InstallScope,
  ProcessRunner,
  ServerSpec,
} from '../../src/mcpClients/types.js';

const spec: ServerSpec = { name: 'simply-teams', command: 'simply', args: ['teams', 'mcp'] };

let root: string;
let environment: InstallEnvironment;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'simply-mcp-clients-'));
  const homedir = path.join(root, 'home');
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(homedir);
  fs.mkdirSync(cwd);
  // APPDATA/XDG point inside the temp home, so no test can touch the real profile on any platform.
  environment = {
    platform: process.platform,
    homedir,
    cwd,
    env: { APPDATA: path.join(homedir, 'AppData'), XDG_CONFIG_HOME: path.join(homedir, '.config') },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(client: ClientId, scope: InstallScope = 'user', server: ServerSpec = spec) {
  return planInstall(server, client, scope, environment);
}

function write(file: string, contents: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

const cursorFile = (): string => path.join(environment.homedir, '.cursor', 'mcp.json');

describe('applyPlan: file clients', () => {
  it('adds an entry to a new file when the client is installed', async () => {
    fs.mkdirSync(path.join(environment.homedir, '.cursor'));

    const result = await applyPlan(plan('cursor'));

    expect(result).toMatchObject({ outcome: 'added', exitCode: 0, target: cursorFile() });
    expect(JSON.parse(fs.readFileSync(cursorFile(), 'utf8'))).toStrictEqual({
      mcpServers: { 'simply-teams': { command: 'simply', args: ['teams', 'mcp'] } },
    });
    expect(fs.existsSync(`${cursorFile()}.bak`)).toBe(false);
  });

  it('refuses to create a file for a client that is not installed', async () => {
    const result = await applyPlan(plan('cursor'));

    expect(result).toMatchObject({ outcome: 'failed', exitCode: 2 });
    expect(result.message).toMatch(/does not appear to be installed/);
    expect(fs.existsSync(cursorFile())).toBe(false);
  });

  it('creates the directory for a project file', async () => {
    const result = await applyPlan(plan('vscode', 'project'));

    expect(result.outcome).toBe('added');
    expect(JSON.parse(fs.readFileSync(path.join(environment.cwd, '.vscode', 'mcp.json'), 'utf8'))).toStrictEqual({
      servers: { 'simply-teams': { type: 'stdio', command: 'simply', args: ['teams', 'mcp'] } },
    });
  });

  it('is unchanged on a second run, and writes nothing', async () => {
    fs.mkdirSync(path.join(environment.homedir, '.cursor'));
    await applyPlan(plan('cursor'));
    const before = fs.statSync(cursorFile()).mtimeMs;

    const result = await applyPlan(plan('cursor'));

    expect(result).toMatchObject({ outcome: 'unchanged', exitCode: 0 });
    expect(fs.statSync(cursorFile()).mtimeMs).toBe(before);
    expect(fs.existsSync(`${cursorFile()}.bak`)).toBe(false);
  });

  it('reports a conflict for a differing entry, then replaces it under --force with a backup', async () => {
    const original = JSON.stringify({ mcpServers: { 'simply-teams': { command: 'old' } } }, null, 2);
    write(cursorFile(), original);

    const conflict = await applyPlan(plan('cursor'));
    expect(conflict).toMatchObject({ outcome: 'conflict', exitCode: 2 });
    expect(conflict.message).toMatch(/--force/);
    expect(fs.readFileSync(cursorFile(), 'utf8')).toBe(original);

    const replaced = await applyPlan(plan('cursor'), { force: true });
    expect(replaced).toMatchObject({ outcome: 'replaced', exitCode: 0 });
    expect(
      (JSON.parse(fs.readFileSync(cursorFile(), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers[
        'simply-teams'
      ],
    ).toStrictEqual({
      command: 'simply',
      args: ['teams', 'mcp'],
    });
    expect(fs.readFileSync(`${cursorFile()}.bak`, 'utf8')).toBe(original);
  });

  it('leaves comments and every other key of a VS Code file byte for byte', async () => {
    const before = [
      '// my servers',
      '{',
      '\t"inputs": [], // keep me',
      '\t"servers": {',
      '\t\t/* the first */',
      '\t\t"other": { "type": "stdio", "command": "other" },',
      '\t},',
      '}',
      '',
    ].join('\r\n');
    const file = write(path.join(environment.cwd, '.vscode', 'mcp.json'), before);

    await applyPlan(plan('vscode', 'project'));

    const after = fs.readFileSync(file, 'utf8');
    const [head] = before.split('\t},');
    // Everything before the insertion point is untouched; the new entry follows the file's tabs and CRLF.
    expect(after.startsWith(head.trimEnd())).toBe(true);
    expect(after).toContain('// keep me');
    expect(after).toContain('/* the first */');
    expect(after).toContain('\t\t"simply-teams": {\r\n\t\t\t"type": "stdio",');
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after.endsWith('}\r\n')).toBe(true);
  });

  it('touches only mcpServers in a Gemini settings file', async () => {
    const file = path.join(environment.homedir, '.gemini', 'settings.json');
    const before = '{\n    "theme": "Dracula",\n    "selectedAuthType": "oauth-personal"\n}\n';
    write(file, before);

    await applyPlan(plan('gemini'));

    const after = fs.readFileSync(file, 'utf8');
    expect(after.startsWith('{\n    "theme": "Dracula",\n    "selectedAuthType": "oauth-personal"')).toBe(true);
    expect(after).toContain('\n    "mcpServers": {\n        "simply-teams": {');
    expect(JSON.parse(after)).toMatchObject({ theme: 'Dracula', selectedAuthType: 'oauth-personal' });
  });

  it('refuses an unparseable file and leaves it untouched', async () => {
    const broken = '{ "mcpServers": { "a": 1, } "oops" }';
    write(cursorFile(), broken);

    const result = await applyPlan(plan('cursor'), { force: true });

    expect(result).toMatchObject({ outcome: 'failed', exitCode: 2 });
    expect(result.message).toContain(cursorFile());
    expect(result.message).toMatch(/not valid JSON/);
    expect(fs.readFileSync(cursorFile(), 'utf8')).toBe(broken);
    expect(fs.existsSync(`${cursorFile()}.bak`)).toBe(false);
  });

  it('refuses a file whose servers key is not an object', async () => {
    write(cursorFile(), '{ "mcpServers": [] }');
    expect(await applyPlan(plan('cursor'))).toMatchObject({ outcome: 'failed', exitCode: 2 });
  });

  it('changes nothing on a dry run, but reports what it would do', async () => {
    write(cursorFile(), '{}\n');

    const result = await applyPlan(plan('cursor'), { dryRun: true });

    expect(result).toMatchObject({ outcome: 'added', dryRun: true, exitCode: 0 });
    expect(result.preview).toContain('"simply-teams"');
    expect(fs.readFileSync(cursorFile(), 'utf8')).toBe('{}\n');
  });

  it('leaves no temporary file behind', async () => {
    write(cursorFile(), '{}');
    await applyPlan(plan('cursor'));
    expect(fs.readdirSync(path.dirname(cursorFile())).sort()).toStrictEqual(['mcp.json', 'mcp.json.bak']);
  });

  it('reports an unsupported scope as a refusal', async () => {
    expect(await applyPlan(plan('windsurf', 'project'))).toMatchObject({ outcome: 'failed', exitCode: 2 });
  });
});

describe('applyPlan: CLI clients', () => {
  const ok: ProcessRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });

  it('runs claude mcp add-json with the entry', async () => {
    const runner = vi.fn(ok);

    const result = await applyPlan(plan('claude-code'), { runner });

    expect(result).toMatchObject({ outcome: 'added', exitCode: 0 });
    expect(runner.mock.calls).toStrictEqual([
      [
        'claude',
        [
          'mcp',
          'add-json',
          'simply-teams',
          '{"type":"stdio","command":"simply","args":["teams","mcp"]}',
          '--scope',
          'user',
        ],
      ],
    ]);
  });

  it('is unchanged when ~/.claude.json already holds the same entry, and runs nothing', async () => {
    write(
      path.join(environment.homedir, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'simply-teams': { type: 'stdio', command: 'simply', args: ['teams', 'mcp'], env: {} } },
      }),
    );
    const runner = vi.fn(ok);

    expect(await applyPlan(plan('claude-code'), { runner })).toMatchObject({ outcome: 'unchanged' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('removes then adds under --force when the codex entry differs', async () => {
    write(path.join(environment.homedir, '.codex', 'config.toml'), '[mcp_servers.simply-teams]\ncommand = "old"\n');
    const runner = vi.fn(ok);

    const conflict = await applyPlan(plan('codex'), { runner });
    expect(conflict).toMatchObject({ outcome: 'conflict', exitCode: 2 });
    expect(runner).not.toHaveBeenCalled();

    const replaced = await applyPlan(plan('codex'), { runner, force: true });
    expect(replaced).toMatchObject({ outcome: 'replaced', exitCode: 0 });
    expect(runner.mock.calls).toStrictEqual([
      ['codex', ['mcp', 'remove', 'simply-teams']],
      ['codex', ['mcp', 'add', 'simply-teams', '--', 'simply', 'teams', 'mcp']],
    ]);
  });

  it('gives the exact command to run by hand when the CLI is not on PATH', async () => {
    const runner: ProcessRunner = async () => {
      throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    };

    const result = await applyPlan(plan('codex'), { runner });

    expect(result).toMatchObject({ outcome: 'failed', exitCode: 2 });
    expect(result.message).toMatch(/codex is not on PATH/);
    expect(result.message).toContain('codex mcp add simply-teams -- simply teams mcp');
  });

  it('reports a CLI that exits non-zero, with its output', async () => {
    const runner: ProcessRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'Invalid JSON\n' });

    const result = await applyPlan(plan('claude-code'), { runner });

    expect(result).toMatchObject({ outcome: 'failed', exitCode: 1 });
    expect(result.message).toMatch(/exited with 1: Invalid JSON$/);
  });

  it('runs nothing on a dry run', async () => {
    const runner = vi.fn(ok);
    expect(await applyPlan(plan('codex'), { runner, dryRun: true })).toMatchObject({ outcome: 'added', dryRun: true });
    expect(runner).not.toHaveBeenCalled();
  });
});
