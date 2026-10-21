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

import { ConfigError } from './errors.js';

export interface SearchFilters {
  /** A sender's name or email address. */
  readonly from?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly mentionsMe?: boolean;
}

const UNITS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Reads a date flag: `2026-10-01`, a full ISO timestamp, or a relative `24h`, `7d`, or `2w` counted
 * back from `now`. Relative forms exist because an agent asked about "this week" should not have
 * to work out today's date first.
 */
export function parseDate(value: string, now: Date = new Date()): Date {
  const text = value.trim();
  const relative = /^(\d+)([hdw])$/i.exec(text);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    return new Date(now.getTime() - Number(relative[1]) * (UNITS[relative[2].toLowerCase()] ?? 0));
  }
  const parsed = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text) ? new Date(text) : undefined;
  if (parsed === undefined || Number.isNaN(parsed.getTime())) {
    throw new ConfigError(`"${value}" is not a date. Use YYYY-MM-DD, an ISO timestamp, or a relative 24h, 7d, or 2w.`);
  }
  return parsed;
}

/**
 * Quotes a value for KQL. A bare word passes through; anything else is wrapped in double quotes
 * with any quotes inside removed, since KQL has no escape for them. That is what keeps
 * `--from 'x OR sent>2000-01-01'` one sender name rather than three terms.
 */
function quote(value: string): string {
  const text = value.replaceAll('"', '').trim();
  return /^[\w.@'-]+$/.test(text) ? text : `"${text}"`;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the search query from the free text plus the filter flags, using the scope terms the
 * Teams search API documents (`from:`, `sent>=`, `sent<=`, `IsMentioned:`). The free text passes
 * through verbatim, so a caller can still write any KQL the flags do not cover.
 */
export function buildSearchQuery(text: string, filters: SearchFilters = {}): string {
  const parts = [text.trim()];
  if (filters.from !== undefined && filters.from.trim() !== '') parts.push(`from:${quote(filters.from)}`);
  if (filters.since !== undefined) parts.push(`sent>=${day(filters.since)}`);
  if (filters.until !== undefined) parts.push(`sent<=${day(filters.until)}`);
  if (filters.mentionsMe === true) parts.push('IsMentioned:true');
  const query = parts.filter((part) => part !== '').join(' ');
  if (query === '') throw new ConfigError('Search needs words to look for, or at least one filter.');
  return query;
}
