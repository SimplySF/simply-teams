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

import { isDeepStrictEqual } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';

/**
 * What a client already has under an entry name, read from a file this module never writes
 * (`~/.claude.json`, `config.toml`). `differs` covers anything that isn't provably the same launch,
 * including an entry this reader can't make sense of: `--force` is then the way through, which is
 * the safe direction to be wrong in.
 */
export type ExistingEntry = 'absent' | 'same' | 'differs';

type Launch = { command: string; args: readonly string[] };

/** @returns How `launch` compares with the user-scope `mcpServers` entry in Claude Code's `~/.claude.json`. */
export function compareClaudeEntry(text: string, name: string, launch: Launch): ExistingEntry {
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  // An unreadable file can't show an entry; `claude` itself reports whatever is wrong with it.
  if (errors.length > 0 || !isRecord(root) || !isRecord(root.mcpServers)) return 'absent';

  const entry = root.mcpServers[name];
  if (entry === undefined) return 'absent';
  if (!isRecord(entry)) return 'differs';

  const { type = 'stdio', command, args = [], env = {}, ...rest } = entry;
  const same =
    type === 'stdio' &&
    command === launch.command &&
    isDeepStrictEqual(args, launch.args) &&
    isDeepStrictEqual(env, {}) &&
    Object.keys(rest).length === 0;
  return same ? 'same' : 'differs';
}

/** @returns How `launch` compares with the `[mcp_servers.<name>]` table in Codex's `config.toml`. */
export function compareCodexEntry(text: string, name: string, launch: Launch): ExistingEntry {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => tableName(line) === `mcp_servers.${name}`);
  if (header === -1) return 'absent';

  const body: string[] = [];
  for (const line of lines.slice(header + 1)) {
    const table = tableName(line);
    if (table !== undefined) {
      // A sub-table such as `[mcp_servers.<name>.env]` is more than a bare launch.
      if (table.startsWith(`mcp_servers.${name}.`)) return 'differs';
      break;
    }
    body.push(line);
  }

  const values = parseKeyValues(body.join('\n'));
  if (!values) return 'differs';
  const { command, args = [], ...rest } = values;
  const same = command === launch.command && isDeepStrictEqual(args, launch.args) && Object.keys(rest).length === 0;
  return same ? 'same' : 'differs';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns The dotted name of a `[table]` header line, with quoted keys unquoted, or undefined. */
function tableName(line: string): string | undefined {
  const match = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  if (!match) return undefined;
  return match[1]
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2'))
    .join('.');
}

type TomlValue = string | string[];

/**
 * Reads `key = "string"` and `key = ["string", …]` pairs, which is all a launch-only server table
 * holds. Anything else makes the whole table unreadable, so the caller treats it as different.
 *
 * @returns The pairs, or undefined if the text holds anything else.
 */
function parseKeyValues(text: string): Record<string, TomlValue> | undefined {
  const tokens = tokenize(text);
  if (!tokens) return undefined;

  const values: Record<string, TomlValue> = {};
  let i = 0;
  while (i < tokens.length) {
    const key = tokens[i];
    if (key.kind !== 'key' || tokens[i + 1]?.kind !== '=') return undefined;
    i += 2;
    const value = tokens[i];
    if (value?.kind === 'string') {
      values[key.value] = value.value;
      i += 1;
      continue;
    }
    if (value?.kind !== '[') return undefined;
    i += 1;
    const items: string[] = [];
    while (tokens[i]?.kind === 'string') {
      items.push(tokens[i].value);
      i += 1;
      if (tokens[i]?.kind === ',') i += 1;
    }
    if (tokens[i]?.kind !== ']') return undefined;
    values[key.value] = items;
    i += 1;
  }
  return values;
}

type Token = { kind: 'key' | 'string'; value: string } | { kind: '=' | '[' | ']' | ','; value: '' };

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  const pattern = /\s+|#[^\n]*|([A-Za-z0-9_-]+)|("(?:[^"\\\n]|\\.)*")|'([^'\n]*)'|([=[\],])|(.)/gy;
  for (const match of text.matchAll(pattern)) {
    const [, key, basic, literal, punctuation, unexpected] = match;
    if (unexpected !== undefined) return undefined;
    if (key !== undefined) tokens.push({ kind: 'key', value: key });
    else if (literal !== undefined) tokens.push({ kind: 'string', value: literal });
    else if (punctuation !== undefined) tokens.push({ kind: punctuation as '=' | '[' | ']' | ',', value: '' });
    else if (basic !== undefined) {
      try {
        // TOML basic strings use JSON's escapes for everything a launch line needs.
        tokens.push({ kind: 'string', value: JSON.parse(basic) as string });
      } catch {
        return undefined;
      }
    }
  }
  return tokens;
}
