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

import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { setNestedEntry } from '../../src/mcpClients/jsonEdit.js';

const entry = { command: 'simply', args: ['teams', 'mcp'] };
const lines = (...text: string[]): string => text.join('\n');

describe('setNestedEntry', () => {
  it('writes a new file', () => {
    expect(setNestedEntry('', 'mcpServers', 'x', entry)).toBe(
      lines(
        '{',
        '  "mcpServers": {',
        '    "x": {',
        '      "command": "simply",',
        '      "args": [',
        '        "teams",',
        '        "mcp"',
        '      ]',
        '    }',
        '  }',
        '}',
        '',
      ),
    );
  });

  it('adds after the last entry without touching it, keeping its comment on its line', () => {
    const before = lines('{', '  "mcpServers": {', '    "other": { "command": "other" } // mine', '  }', '}', '');
    expect(setNestedEntry(before, 'mcpServers', 'x', { command: 'simply' })).toBe(
      lines(
        '{',
        '  "mcpServers": {',
        '    "other": { "command": "other" }, // mine',
        '    "x": {',
        '      "command": "simply"',
        '    }',
        '  }',
        '}',
        '',
      ),
    );
  });

  it('respects an existing trailing comma, tabs and CRLF', () => {
    const before = ['{', '\t"servers": {', '\t\t"other": {},', '\t},', '}', ''].join('\r\n');
    expect(setNestedEntry(before, 'servers', 'x', { type: 'stdio' })).toBe(
      ['{', '\t"servers": {', '\t\t"other": {},', '\t\t"x": {', '\t\t\t"type": "stdio"', '\t\t}', '\t},', '}', ''].join(
        '\r\n',
      ),
    );
  });

  it('adds the servers key to a settings file, leaving every other setting alone', () => {
    const before = lines('{', '    "theme": "Dracula" /* dark */', '}', '');
    expect(setNestedEntry(before, 'mcpServers', 'x', { command: 'simply' })).toBe(
      lines(
        '{',
        '    "theme": "Dracula", /* dark */',
        '    "mcpServers": {',
        '        "x": {',
        '            "command": "simply"',
        '        }',
        '    }',
        '}',
        '',
      ),
    );
  });

  it('fills an empty object', () => {
    expect(setNestedEntry('{}', 'mcpServers', 'x', {})).toBe(
      lines('{', '  "mcpServers": {', '    "x": {}', '  }', '}'),
    );
    expect(setNestedEntry('{ "mcpServers": {} }', 'mcpServers', 'x', {})).toBe(
      lines('{ "mcpServers": {', '  "x": {}', '} }'),
    );
  });

  it('adds inside a one-line object', () => {
    const after = setNestedEntry('{ "mcpServers": { "a": {} } }', 'mcpServers', 'x', {});
    expect(after).toBe('{ "mcpServers": { "a": {},\n  "x": {} } }');
    expect(parse(after)).toStrictEqual({ mcpServers: { a: {}, x: {} } });
  });

  it('replaces only the existing value, keeping its neighbours byte for byte', () => {
    const before = lines('{', '  "mcpServers": {', '    "x": { "command": "old" }, "keep": 1 // note', '  }', '}');
    expect(setNestedEntry(before, 'mcpServers', 'x', { command: 'new' })).toBe(
      lines('{', '  "mcpServers": {', '    "x": {', '      "command": "new"', '    }, "keep": 1 // note', '  }', '}'),
    );
  });

  it('keeps a comment inside an otherwise empty object', () => {
    const after = setNestedEntry('{\n  "mcpServers": { /* none yet */ }\n}', 'mcpServers', 'x', {});
    expect(after).toContain('/* none yet */');
    expect(parse(after, [], { allowTrailingComma: true })).toStrictEqual({ mcpServers: { x: {} } });
  });
});
