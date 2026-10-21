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

import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser';

type Edit = { offset: number; length: number; content: string };

/**
 * Sets `root[key][name] = value` in JSON or JSONC text, changing no byte outside that entry.
 *
 * Not `jsonc-parser`'s `modify`: given formatting options, it reformats the neighbouring entry and
 * can move a trailing comment onto the new line, and without them it writes the value on one line.
 * Here the new text is the only text: it takes the file's own indentation and line endings, and a
 * comment after the previous entry stays on that entry's line.
 *
 * @param text - The file, already known to parse to an object whose `key`, if present, is an object.
 * @returns The new text.
 */
export function setNestedEntry(text: string, key: string, name: string, value: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(text);

  if (text.trim() === '') {
    return [`{`, `${unit}${property(key, { [name]: value }, unit, unit, eol)}`, `}`, ''].join(eol);
  }

  const root = parseTree(text, [], { allowTrailingComma: true }) as Node;
  const existing = findNodeAtLocation(root, [key, name]);
  if (existing) {
    const indent = lineIndent(text, (existing.parent as Node).offset);
    return applyEdit(text, {
      offset: existing.offset,
      length: existing.length,
      content: formatValue(value, indent, unit, eol),
    });
  }

  const servers = findNodeAtLocation(root, [key]);
  return servers
    ? insertProperty(text, servers, name, value, unit, eol)
    : insertProperty(text, root, key, { [name]: value }, unit, eol);
}

function insertProperty(text: string, object: Node, name: string, value: unknown, unit: string, eol: string): string {
  const properties = object.children ?? [];
  const parentIndent = lineIndent(text, object.offset);

  if (properties.length === 0) {
    const indent = parentIndent + unit;
    const open = object.offset + 1;
    const close = object.offset + object.length - 1;
    const inner = text.slice(open, close);
    const content = `${eol}${indent}${property(name, value, indent, unit, eol)}`;
    // `{}` becomes a block; anything inside an otherwise empty object (a comment) is kept after it.
    return inner.trim() === ''
      ? applyEdit(text, { offset: open, length: close - open, content: `${content}${eol}${parentIndent}` })
      : applyEdit(text, { offset: open, length: 0, content: `${content},` });
  }

  const last = properties.at(-1) as Node;
  const first = properties[0];
  const indent = startsLine(text, first.offset) ? lineIndent(text, first.offset) : parentIndent + unit;
  const valueEnd = last.offset + last.length;

  // A trailing comma already separates the last entry from whatever follows it.
  const afterValue = /^\s*,/.exec(text.slice(valueEnd));
  const commaEnd = afterValue ? valueEnd + afterValue[0].length : valueEnd;

  // The new entry goes after anything else on the last entry's line (a `// comment`), unless that
  // line also closes the object, as in `{ "a": 1 }`.
  const lineEnd = endOfLine(text, commaEnd);
  const restOfLine = text.slice(commaEnd, lineEnd);
  const at = /^[ \t]*(\/\/.*|\/\*.*?\*\/[ \t]*)?$/.test(restOfLine) ? lineEnd : commaEnd;
  const entry = `${eol}${indent}${property(name, value, indent, unit, eol)}`;

  if (afterValue) return applyEdit(text, { offset: at, length: 0, content: entry });
  if (at === valueEnd) return applyEdit(text, { offset: at, length: 0, content: `,${entry}` });
  return applyEdits(text, [
    { offset: valueEnd, length: 0, content: ',' },
    { offset: at, length: 0, content: entry },
  ]);
}

function property(name: string, value: unknown, indent: string, unit: string, eol: string): string {
  return `${JSON.stringify(name)}: ${formatValue(value, indent, unit, eol)}`;
}

/** @returns `value` as JSON, its continuation lines indented from `indent`. */
function formatValue(value: unknown, indent: string, unit: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/** @returns The file's indentation step: its first indented line's leading tab or spaces, else two spaces. */
function indentUnit(text: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (!indent) return '  ';
  return indent.startsWith('\t') ? '\t' : indent;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? '';
}

function startsLine(text: string, offset: number): boolean {
  return text.slice(lineStart(text, offset), offset).trim() === '';
}

function endOfLine(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  if (newline === -1) return text.length;
  return text[newline - 1] === '\r' ? newline - 1 : newline;
}

function applyEdit(text: string, edit: Edit): string {
  return applyEdits(text, [edit]);
}

/** Applies non-overlapping edits, last first, so earlier offsets stay valid. */
function applyEdits(text: string, edits: Edit[]): string {
  return [...edits]
    .sort((a, b) => b.offset - a.offset)
    .reduce(
      (result, edit) => result.slice(0, edit.offset) + edit.content + result.slice(edit.offset + edit.length),
      text,
    );
}
