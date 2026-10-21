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

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { buildSearchQuery, parseDate } from '../src/kql.js';

describe('buildSearchQuery', () => {
  it('appends each filter as the documented KQL term', () => {
    expect(
      buildSearchQuery('release freeze', {
        from: 'ada@contoso.com',
        since: new Date('2026-10-01T00:00:00Z'),
        until: new Date('2026-10-20T00:00:00Z'),
        mentionsMe: true,
      }),
    ).toBe('release freeze from:ada@contoso.com sent>=2026-10-01 sent<=2026-10-20 IsMentioned:true');
  });

  it('passes the free text through, so callers can write their own KQL', () => {
    expect(buildSearchQuery('deploy hasAttachment:true')).toBe('deploy hasAttachment:true');
  });

  it('quotes a sender with spaces, so it stays one value', () => {
    expect(buildSearchQuery('x', { from: 'Ada Lovelace' })).toBe('x from:"Ada Lovelace"');
  });

  it('cannot be made to add terms through a filter value', () => {
    expect(buildSearchQuery('x', { from: 'bob" OR sent>2000-01-01 "' })).toBe('x from:"bob OR sent>2000-01-01"');
  });

  it('allows a filter alone, but not nothing at all', () => {
    expect(buildSearchQuery('', { mentionsMe: true })).toBe('IsMentioned:true');
    expect(() => buildSearchQuery('  ')).toThrow(ConfigError);
  });
});

describe('parseDate', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('reads relative hours, days, and weeks back from now', () => {
    expect(parseDate('24h', now).toISOString()).toBe('2026-10-20T12:00:00.000Z');
    expect(parseDate('7d', now).toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(parseDate('2W', now).toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });

  it('reads calendar dates and ISO timestamps', () => {
    expect(parseDate('2026-10-01T09:30:00Z').toISOString()).toBe('2026-10-01T09:30:00.000Z');
    expect(Number.isNaN(parseDate('2026-10-01').getTime())).toBe(false);
  });

  it.each(['yesterday', '10/21/2026', '2026-13-45', '7 days'])('refuses %s, naming the forms it takes', (value) => {
    expect(() => parseDate(value, now)).toThrow(/YYYY-MM-DD.*7d/);
  });
});
