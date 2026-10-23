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

import { secretsIn, type TeamsGuard } from './guard.js';

/** What cleaning did to one result: how many items were withheld, and how much was replaced. */
export interface GuardReport {
  /** Messages, hits, previews or fields withheld whole because they held a secret. */
  readonly withheld: number;
  /** How many of each kind of personal data were replaced with placeholders. */
  readonly redacted: Readonly<Record<string, number>>;
  /** One sentence, for a person or an agent: what was removed, or that nothing was. */
  readonly summary: string;
}

/**
 * Free text written by people, keyed by the field it sits in. An object holding one of these is
 * one item (a message, a search hit, a chat's preview): a secret anywhere in it withholds all of
 * its free text, not just the matched part, so an agent never sees the rest of a message that was
 * sharing a credential (design 0005).
 */
const FREE_TEXT = new Set(['text', 'subject', 'summary', 'topic', 'preview', 'description', 'where']);

/**
 * Identifiers and machine values: never personal data, and rewriting them would break the refs an
 * agent passes back. Everything else that is a string is checked.
 */
const IDENTIFIERS = new Set([
  'ref',
  'id',
  'chatId',
  'teamId',
  'channelId',
  'userId',
  'replyToId',
  'webUrl',
  'url',
  'createdAt',
  'editedAt',
  'at',
  'kind',
  'type',
  'membershipType',
  'method',
  'path',
  'contentType',
  'userIdentityType',
  'hitIds',
]);

function withheldNote(types: readonly string[]): string {
  return `[withheld: contains a secret (${[...new Set(types)].join(', ')})]`;
}

type Json = unknown;

class Cleaner {
  public withheld = 0;
  public readonly redacted: Record<string, number> = {};
  /** Items by ref, so one that appears twice in a result (a view's message, and in its thread) is counted once. */
  private readonly seen = new Map<string, Record<string, Json>>();

  public constructor(private readonly guard: TeamsGuard) {}

  public clean(value: Json): Json {
    if (typeof value === 'string') return this.cleanString(value);
    if (Array.isArray(value)) return value.map((item: Json) => this.clean(item));
    if (typeof value !== 'object' || value === null) return value;
    return this.cleanObject(value as Record<string, Json>);
  }

  private cleanObject(object: Record<string, Json>): Record<string, Json> {
    // A thread and its first message share a ref (0006), so the shape is part of the key.
    const key = typeof object.ref === 'string' ? `${object.ref}#${Object.keys(object).sort().join(',')}` : undefined;
    const already = key === undefined ? undefined : this.seen.get(key);
    if (already !== undefined) return already;
    const cleaned = this.cleanItem(object);
    if (key !== undefined) this.seen.set(key, cleaned);
    return cleaned;
  }

  private cleanItem(object: Record<string, Json>): Record<string, Json> {
    const secrets = secretsInItem(object);
    if (secrets.length > 0) this.withheld += 1;
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(object)) {
      if (secrets.length > 0 && FREE_TEXT.has(key) && typeof item === 'string') {
        out[key] = withheldNote(secrets);
      } else if (secrets.length > 0 && key === 'attachments' && Array.isArray(item)) {
        out[key] = item.map((attachment: Json) =>
          // A file's link ends in its name, so the link goes with it.
          typeof attachment === 'object' && attachment !== null
            ? { ...attachment, name: undefined, url: undefined }
            : attachment,
        );
      } else if (IDENTIFIERS.has(key)) {
        out[key] = item;
      } else if (FREE_TEXT.has(key) && typeof item === 'string') {
        // Already known to hold no secret: only personal data is left to replace.
        out[key] = this.guard.redact(item, this.redacted);
      } else {
        out[key] = this.clean(item);
      }
    }
    return out;
  }

  /** A string outside any item: a secret withholds it alone, and personal data is replaced. */
  private cleanString(text: string): string {
    const secrets = secretsIn(text);
    if (secrets.length > 0) {
      this.withheld += 1;
      return withheldNote(secrets);
    }
    return this.guard.redact(text, this.redacted);
  }
}

/** The secrets in an item's own free text and attachment names; nested items are checked on their own. */
function secretsInItem(object: Record<string, Json>): string[] {
  const texts: string[] = [];
  for (const [key, item] of Object.entries(object)) {
    if (FREE_TEXT.has(key) && typeof item === 'string') texts.push(item);
  }
  const attachments = object.attachments;
  if (texts.length > 0 && Array.isArray(attachments)) {
    for (const attachment of attachments) {
      const name = (attachment as { name?: unknown } | null)?.name;
      if (typeof name === 'string') texts.push(name);
    }
  }
  // Each field on its own: an assignment-style pattern must not run from one field into the next.
  return texts.flatMap((text) => secretsIn(text));
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${noun}${noun.endsWith('s') ? 'es' : 's'}`;
}

function describe(withheld: number, redacted: Readonly<Record<string, number>>): string {
  const parts = Object.entries(redacted).map(([type, count]) => plural(count, type));
  const notes: string[] = [];
  if (withheld > 0) notes.push(`${plural(withheld, 'item')} withheld for holding a secret`);
  if (parts.length > 0) notes.push(`${parts.join(', ')} replaced with placeholders`);
  return notes.length === 0 ? 'Cleaned: nothing needed removing.' : `Cleaned: ${notes.join('; ')}.`;
}

/**
 * Cleans a result before an agent sees it (design 0005). Any item whose free text holds a secret
 * has all of its free text withheld; every other string has its personal data replaced with this
 * guard's placeholders. Identifiers and refs are left exactly as they were, so the agent can still
 * fetch, reply to, or open what it was shown.
 */
export function cleanResult<T>(guard: TeamsGuard, value: T): { value: T; report: GuardReport } {
  const cleaner = new Cleaner(guard);
  const cleaned = cleaner.clean(value) as T;
  return {
    value: cleaned,
    report: {
      withheld: cleaner.withheld,
      redacted: cleaner.redacted,
      summary: describe(cleaner.withheld, cleaner.redacted),
    },
  };
}

/**
 * Puts real values back into what an agent sends: every string in a tool's input, so a reply that
 * mentions "[EMAIL-1]", or a search for it, reaches Teams with the real address (design 0005).
 */
export function restoreInput<T>(guard: TeamsGuard, value: T): T {
  if (typeof value === 'string') return guard.restore(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => restoreInput(guard, item)) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, restoreInput(guard, item)]),
  ) as T;
}
