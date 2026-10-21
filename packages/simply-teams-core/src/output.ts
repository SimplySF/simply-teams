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

/** One labelled value in a detail view. `undefined` values are dropped, not printed as blanks. */
export type Pair = readonly [label: string, value: unknown];

export interface Column<Row> {
  readonly header: string;
  readonly value: (row: Row) => unknown;
}

const EM_DASH = '—';

import { stripControl, stripControlOneLine } from './text.js';

export { stripControl, stripControlOneLine } from './text.js';

/** Renders any API value as one line of terminal text; missing values read as an em dash. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  if (typeof value === 'string') return stripControlOneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stripControl(JSON.stringify(value));
}

/** Right-pads to `width`, counting characters (adequate for the ASCII-ish fields we render). */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Aligned `Label: value` lines for a single entity. */
export function formatKeyValue(pairs: readonly Pair[]): string {
  const shown = pairs.filter(([, value]) => value !== undefined);
  if (shown.length === 0) return '';
  // Reduced for the same reason as formatTable's widths, so the dangerous pattern is not left
  // sitting one function above the fix for it.
  const labelWidth = shown.reduce((widest, [label]) => Math.max(widest, label.length), 0);
  return shown.map(([label, value]) => `${pad(`${label}:`, labelWidth + 1)} ${cell(value)}`).join('\n');
}

/**
 * Two-space-separated columns with a header rule. Every column is sized to its widest cell, and
 * the last column is never padded so trailing whitespace never lands in a pipeline.
 */
export function formatTable<Row>(rows: readonly Row[], columns: ReadonlyArray<Column<Row>>): string {
  if (rows.length === 0) return '';

  const body = rows.map((row) => columns.map((column) => cell(column.value(row))));
  // Reduced rather than spread into Math.max: `...body.map(...)` puts one argument on the stack
  // per row, which throws RangeError somewhere past 100k rows. A tenant can return that many
  // links, and an ungraceful crash is a worse answer than a wide table.
  const widths = columns.map((column, index) =>
    body.reduce((widest, cells) => Math.max(widest, (cells[index] ?? '').length), column.header.length),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((text, index) => (index === cells.length - 1 ? text : pad(text, widths[index] ?? 0)))
      .join('  ')
      .trimEnd();

  return [
    render(columns.map((column) => column.header)),
    render(widths.map((width) => '─'.repeat(width))),
    ...body.map(render),
  ].join('\n');
}
