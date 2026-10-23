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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools.js';

/**
 * The CLI's generated command list. Cross-checking against it is the point of this file: a
 * command added to the CLI without a tool here would otherwise ship unexposed to agents, and a
 * tool naming a command that no longer exists would document something that cannot be run.
 */
const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../simply-teams/command-snapshot.json', import.meta.url)), 'utf8'),
) as Array<{ command: string }>;

const cliCommands = new Set(snapshot.map((entry) => entry.command));

describe('the tool catalogue', () => {
  it('gives every tool a unique name', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every tool teams_<noun>_<verb> in snake case', () => {
    for (const tool of TOOLS) expect(tool.name).toMatch(/^teams(_[a-z]+)+$/);
  });

  /**
   * Commands deliberately not exposed as tools, each with the design document that argues for it.
   *
   * An allowlist rather than a relaxed assertion: a command added tomorrow without a tool still
   * fails, and adding an entry here is a visible decision rather than a quiet omission.
   */
  const DELIBERATELY_UNEXPOSED: Readonly<Record<string, string>> = {
    'teams:auth:login': 'docs/design/0001: the server never prompts; signing in is a person at a terminal',
  };

  it('covers every CLI command, except the ones deliberately left out', () => {
    const covered = new Set(TOOLS.map((tool) => tool.command.join(':')));
    const missing = [...cliCommands].filter(
      (command) => !covered.has(command) && DELIBERATELY_UNEXPOSED[command] === undefined,
    );
    expect(missing).toStrictEqual([]);
  });

  it('does not list a command as deliberately unexposed once it has a tool', () => {
    // Otherwise the allowlist quietly outlives the decision it records.
    const covered = new Set(TOOLS.map((tool) => tool.command.join(':')));
    expect(Object.keys(DELIBERATELY_UNEXPOSED).filter((command) => covered.has(command))).toStrictEqual([]);
  });

  it('only excuses commands the CLI actually has', () => {
    expect(Object.keys(DELIBERATELY_UNEXPOSED).filter((command) => !cliCommands.has(command))).toStrictEqual([]);
  });

  it('names only commands the CLI actually has', () => {
    const missing = TOOLS.map((tool) => tool.command.join(':')).filter((command) => !cliCommands.has(command));
    expect(missing).toStrictEqual([]);
  });

  it('gives every write tool a dryRun input, so a change can always be previewed', () => {
    for (const tool of TOOLS.filter((entry) => entry.kind === 'write')) {
      expect(Object.keys(tool.inputSchema)).toContain('dryRun');
    }
  });

  it('marks exactly the posting tools as writes (design 0004)', () => {
    expect(TOOLS.filter((tool) => tool.kind === 'write').map((tool) => tool.name)).toStrictEqual([
      'teams_channel_post',
      'teams_message_reply',
      'teams_chat_send',
    ]);
  });

  it('gives every tool a title and a description worth reading', () => {
    for (const tool of TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
