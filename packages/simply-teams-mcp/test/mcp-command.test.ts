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

import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamsMcp from '../src/commands/teams/mcp.js';
import { selectTools } from '../src/index.js';

/**
 * The `teams mcp` command's one hard requirement is that stdout carries protocol traffic and
 * nothing else. Everything here defends that, because a violation does not fail loudly — it
 * corrupts a client session with an error that points nowhere near the cause.
 */

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('teams mcp', () => {
  it('keeps oclif away from stdout by leaving --json off', () => {
    // The shared CLI base class enables it, which makes oclif print a command's return value to
    // stdout. That is why this command extends Command directly, and why this is asserted.
    expect(TeamsMcp.enableJsonFlag).toBe(false);
  });

  it('does not accept a --json flag at all', async () => {
    await expect(TeamsMcp.run(['--json'])).rejects.toThrow();
  });

  it('lists tools on stderr, never stdout', async () => {
    await TeamsMcp.run(['--list']);

    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toMatch(/tool\(s\) would be registered/);
  });

  it('lists exactly the read tools by default', async () => {
    await TeamsMcp.run(['--list']);

    const expected = selectTools(false);
    expect(stderr.join('')).toContain(`${expected.length} tool(s) would be registered`);
    for (const tool of expected) expect(stderr.join('')).toContain(tool.name);
  });

  it('lists the write tools too under --allow-writes', async () => {
    await TeamsMcp.run(['--list', '--allow-writes']);

    const all = selectTools(true);
    expect(stderr.join('')).toContain(`${all.length} tool(s) would be registered`);
    expect(stderr.join('')).toMatch(/writes allowed/);
    // The default really is smaller: the write tools (design 0004) appear only with the flag.
    expect(all.length).toBeGreaterThan(selectTools(false).length);
    expect(stderr.join('')).toContain('teams_channel_post');
  });

  it('says whether it is read-only, so a listing is never ambiguous', async () => {
    await TeamsMcp.run(['--list']);
    expect(stderr.join('')).toMatch(/read-only/);
  });
});
