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

// Ported from simply-confluence-explorer's test/guard.test.ts: the same corpus, held to the same
// detectors (design 0005). The fake secrets are assembled from parts, so this file never holds a
// whole one and a repository secret scanner has nothing to find here.

import { describe, expect, it } from 'vitest';
import { DETECTOR_TYPES, secretsIn, TeamsGuard } from '../src/guard.js';
import { cleanResult, restoreInput } from '../src/guard-results.js';
import type { TeamsMessage } from '../src/messages.js';

const j = (...parts: string[]): string => parts.join('');

// Samples shaped like the real thing, one or more for each detector.
const SECRETS: Record<string, string[]> = {
  'private key': [j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----')],
  'AWS access key': [j('AKIA', 'IOSFODNN7', 'EXAMPLE')],
  'GitHub token': [j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')],
  'GitLab token': [j('glpat', '-', 'x9Yz8WvU7tS6rQ5pO4nM')],
  'Slack token': [j('xox', 'b-', '1234567890-abcdefABCDEF')],
  'Atlassian API token': [j('ATATT3', 'xFfGF0', 'a'.repeat(40))],
  'Google API key': [j('AIza', 'Sy', 'B'.repeat(33))],
  'AI provider key': [j('sk-', 'ant-', 'api03-', 'Q'.repeat(40)), j('sk-', 'proj-', 'Z'.repeat(40))],
  'Stripe key': [j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')],
  'JSON web token': [
    j(
      'eyJ',
      'hbGciOiJIUzI1NiJ9',
      '.',
      'eyJ',
      'zdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ),
  ],
  'connection string with a password': [j('postgres://app:', 'S3cr3tPw', '@db.internal:5432/app')],
  'Azure storage key': [j('DefaultEndpointsProtocol=https;AccountName=x;', 'AccountKey=', 'k'.repeat(60))],
  'password or secret value': [
    'db_password = hunter2-prod-9',
    'client_secret: "Xy7-abc-123-def"',
    'api_key=9f8e7d6c5b4a',
  ],
};

const PII: Record<string, string[]> = {
  'email address': ['jane.doe@example.com'],
  'US social security number': ['123-45-6789'],
  'card number': ['4111 1111 1111 1111', '5500-0000-0000-0004'],
  IBAN: ['GB82 WEST 1234 5698 7654 32', 'DE89370400440532013000'],
  'phone number': ['+1 415-555-0132', '(212) 555-0199'],
};

// Text that must pass untouched: placeholders, references to secrets, and numbers that only look
// like personal data.
const BENIGN = [
  'password: ********',
  'password=<your password>',
  'DB_PASSWORD=${DB_PASSWORD}',
  'api_key: YOUR_API_KEY',
  'Reset your password from the profile page.',
  'Connect with postgres://app@db.internal:5432/app',
  'Released on 2026-10-15 at 09:30, build 1792088620843.',
  'Page id 360526, version 4.2.1, port 8090.',
  'The token is set by the server environment.',
  '[EMAIL-1] wrote this section.',
  'see 19:aaaa-bbbb_cccc-dddd@unq.gbl.spaces and 19:abc@thread.skype',
];

describe('TeamsGuard', () => {
  it('has samples for every built-in detector, and every sample belongs to a detector', () => {
    const corpus = new Set([...Object.keys(SECRETS), ...Object.keys(PII)]);
    const declared = new Set(DETECTOR_TYPES.map((detector) => detector.type));
    for (const type of declared) expect(corpus.has(type), `detector "${type}" has no samples`).toBe(true);
    for (const type of corpus)
      expect(declared.has(type), `samples for "${type}", which no detector declares`).toBe(true);
  });

  it('finds each secret by type', () => {
    for (const [type, samples] of Object.entries(SECRETS)) {
      for (const sample of samples) {
        expect(secretsIn(`intro\n${sample}\nmore`), type).toContain(type);
      }
    }
  });

  it('replaces each kind of personal data with a placeholder, and restores only addresses and phone numbers', () => {
    const restorable = new Set(['email address', 'phone number']);
    for (const [type, samples] of Object.entries(PII)) {
      for (const sample of samples) {
        const guard = new TeamsGuard();
        const tally: Record<string, number> = {};
        const out = guard.redact(`contact: ${sample} today`, tally);
        expect(out, type).not.toContain(sample);
        expect(out, type).toMatch(/\[[A-Z_]+-1\]/);
        expect(tally[type], type).toBe(1);
        // A card, SSN or IBAN seen in one chat must not be carried by an agent into another.
        expect(guard.restore(out), type).toBe(restorable.has(type) ? `contact: ${sample} today` : out);
      }
    }
  });

  it('puts every value it replaced back behind its placeholder, plain or URL-encoded', () => {
    const guard = new TeamsGuard();
    guard.redact('ada@contoso.com and ada@contoso.com.au');
    expect(guard.rehide('GET /users/ada%40contoso.com failed; also /users/ada@contoso.com.au')).toBe(
      'GET /users/[EMAIL-1] failed; also /users/[EMAIL-2]',
    );
    expect(guard.rehide('nothing here')).toBe('nothing here');
  });

  it('leaves benign text alone: placeholders, references to secrets, and numbers that only look personal', () => {
    for (const text of BENIGN) {
      const guard = new TeamsGuard();
      expect(secretsIn(text), text).toStrictEqual([]);
      expect(guard.redact(text), text).toBe(text);
    }
  });

  it('keeps a placeholder stable for the life of the guard', () => {
    const guard = new TeamsGuard();
    expect(guard.redact('a@example.com b@example.com a@example.com')).toBe('[EMAIL-1] [EMAIL-2] [EMAIL-1]');
    expect(guard.redact('again a@example.com')).toBe('again [EMAIL-1]');
    expect(guard.restore('[EMAIL-2] and [EMAIL-9]')).toBe('b@example.com and [EMAIL-9]');
  });
});

function message(id: string, text: string, extra: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    ref: `19:chat@thread.v2/${id}`,
    id,
    kind: 'message',
    chatId: '19:chat@thread.v2',
    from: { name: 'Ada', userId: 'u-1' },
    createdAt: '2026-10-22T14:00:00Z',
    deleted: false,
    text,
    attachments: [],
    webUrl: `https://teams.microsoft.com/l/message/19:chat@thread.v2/${id}`,
    ...extra,
  };
}

describe('cleanResult', () => {
  const aws = j('AKIA', 'IOSFODNN7', 'EXAMPLE');

  it('withholds the whole text of a message holding a secret, and keeps its ref and author', () => {
    const { value, report } = cleanResult(new TeamsGuard(), {
      items: [message('1', `here is the key ${aws} for prod`, { subject: 'creds' }), message('2', 'all good')],
      pages: 1,
      complete: true,
    });
    const [first, second] = value.items;
    expect(first?.text).toBe('[withheld: contains a secret (AWS access key)]');
    expect(first?.subject).toBe('[withheld: contains a secret (AWS access key)]');
    expect(first?.ref).toBe('19:chat@thread.v2/1');
    expect(first?.from?.name).toBe('Ada');
    expect(JSON.stringify(value)).not.toContain(aws);
    expect(second?.text).toBe('all good');
    expect(report.withheld).toBe(1);
    expect(report.summary).toBe('Cleaned: 1 item withheld for holding a secret.');
  });

  it('withholds a message whose attachment name holds a secret, and drops the names and links', () => {
    const { value } = cleanResult(
      new TeamsGuard(),
      message('3', 'see attached', {
        attachments: [{ name: `${aws}.txt`, kind: 'file', url: `https://contoso.sharepoint.com/x/${aws}.txt` }],
      }),
    );
    expect(value.text).toMatch(/withheld/);
    expect(value.attachments[0]?.name).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain(aws);
  });

  it('scans each field on its own, so a pattern cannot run from the subject into the text', () => {
    const { value, report } = cleanResult(
      new TeamsGuard(),
      message('10', 'see-the-wiki-page', { subject: 'API_KEY =' }),
    );
    expect(report.withheld).toBe(0);
    expect(value.text).toBe('see-the-wiki-page');
  });

  it('counts a message that appears twice in a view once', () => {
    const secret = message('8', `key ${aws}`);
    const { value, report } = cleanResult(new TeamsGuard(), {
      message: secret,
      thread: [secret, message('9', 'ok')],
      warnings: [],
    });
    expect(report.withheld).toBe(1);
    expect(report.summary).toBe('Cleaned: 1 item withheld for holding a secret.');
    expect(value.thread[0]?.text).toMatch(/withheld/);
  });

  it('replaces personal data across a result with placeholders that stay the same, and leaves identifiers alone', () => {
    const guard = new TeamsGuard();
    const { value, report } = cleanResult(guard, [
      message('4', 'mail jane.doe@example.com or call (212) 555-0199'),
      message('5', 'jane.doe@example.com again'),
    ]);
    expect(value[0]?.text).toBe('mail [EMAIL-1] or call [PHONE-1]');
    expect(value[1]?.text).toBe('[EMAIL-1] again');
    expect(value[0]?.ref).toBe('19:chat@thread.v2/4');
    expect(report.redacted).toStrictEqual({ 'email address': 2, 'phone number': 1 });
    expect(report.summary).toBe('Cleaned: 2 email addresses, 1 phone number replaced with placeholders.');
  });

  it('cleans search hits and chat previews the same way', () => {
    const { value } = cleanResult(new TeamsGuard(), {
      hits: [{ ref: 'r', id: '1', summary: `the **token** ${aws}` }],
      chats: [{ ref: 'c', id: 'c', topic: 'Ops', lastMessage: { from: 'Bo', preview: 'ping jane.doe@example.com' } }],
    });
    expect(value.hits[0]?.summary).toMatch(/withheld/);
    expect(value.chats[0]?.lastMessage.preview).toBe('ping [EMAIL-1]');
  });

  it('says so when nothing needed removing', () => {
    expect(cleanResult(new TeamsGuard(), message('6', 'hello')).report.summary).toBe(
      'Cleaned: nothing needed removing.',
    );
  });
});

describe('restoreInput', () => {
  it('puts real values back into every string an agent sends, and leaves unknown placeholders as written', () => {
    const guard = new TeamsGuard();
    cleanResult(guard, message('7', 'from jane.doe@example.com'));
    expect(
      restoreInput(guard, { text: 'thanks [EMAIL-1], cc [EMAIL-4]', mentions: ['[EMAIL-1]'], dryRun: true }),
    ).toStrictEqual({
      text: 'thanks jane.doe@example.com, cc [EMAIL-4]',
      mentions: ['jane.doe@example.com'],
      dryRun: true,
    });
  });
});
