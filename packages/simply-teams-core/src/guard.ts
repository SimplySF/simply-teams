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

// Ported from simply-confluence-explorer's src/ai/guard.ts (its ADR-022), which checks text before
// it leaves the machine for an AI. Here the agent is the AI: simply-teams hands Teams content to
// whatever agent called it, so the same detectors run on what the MCP server returns (design 0005).
// The detectors, the placeholder filter and the checksums are unchanged; the rules file, images and
// the provider payload types are left behind, because nothing here sends to a provider itself.

/** A secret withholds the message that holds it; personal data is replaced with a placeholder. */
export type FindingKind = 'secret' | 'personal';

interface Detector {
  readonly type: string;
  readonly kind: FindingKind;
  readonly pattern: RegExp;
  /** A match only counts when this agrees, such as a Luhn check or a placeholder filter. */
  readonly confirm?: (match: string, groups: ReadonlyArray<string | undefined>) => boolean;
  /** For assignment-style secrets: the part of the match that is the secret. */
  readonly valueGroup?: number;
}

function luhn(digits: string): boolean {
  const d = digits.replaceAll(/\D/g, '');
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const s = iban.replaceAll(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replaceAll(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

/** Values that document a secret's place rather than being one, including this guard's own placeholders. */
const PLACEHOLDER =
  /^(?:\*+|x+|\.{3,}|<[^>]+>|\$\{?[A-Z0-9_]+\}?|%[A-Z0-9_]+%|\{\{[^}]+\}\}|changeme|change-me|password|secret|example|redacted|your[-_ ].*|none|null|true|false|\[[A-Z]+-\d+\])$/i;

const notPlaceholder = (_match: string, groups: ReadonlyArray<string | undefined>): boolean =>
  !PLACEHOLDER.test(groups[1] ?? '');

const DETECTORS: readonly Detector[] = [
  {
    type: 'private key',
    kind: 'secret',
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  },
  { type: 'AWS access key', kind: 'secret', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'GitHub token', kind: 'secret', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { type: 'GitLab token', kind: 'secret', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'Slack token', kind: 'secret', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'Atlassian API token', kind: 'secret', pattern: /\bATATT3[A-Za-z0-9_=-]{40,}\b/g },
  { type: 'Google API key', kind: 'secret', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'AI provider key', kind: 'secret', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: 'Stripe key', kind: 'secret', pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  {
    type: 'JSON web token',
    kind: 'secret',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    type: 'connection string with a password',
    kind: 'secret',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s/]+/gi,
    valueGroup: 1,
    confirm: notPlaceholder,
  },
  { type: 'Azure storage key', kind: 'secret', pattern: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g, valueGroup: 1 },
  {
    type: 'password or secret value',
    kind: 'secret',
    // A prefix such as db_ or smtp- is part of the name: db_password is still a password.
    pattern:
      /\b(?:\w*[_-])?(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?([^\s"'<>,;]{6,})/gi,
    valueGroup: 1,
    confirm: notPlaceholder,
  },
  // Not right after a slash: user@host in a URL is a login name, not an email address.
  {
    type: 'email address',
    kind: 'personal',
    pattern: /(?<![/\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'US social security number',
    kind: 'personal',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  // A card prefix (Visa, Mastercard, Amex, Discover) as well as the checksum, so a timestamp is not a card.
  {
    type: 'card number',
    kind: 'personal',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confirm: (match) => /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(match.replaceAll(/\D/g, '')) && luhn(match),
  },
  {
    type: 'IBAN',
    kind: 'personal',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    confirm: (match) => ibanValid(match),
  },
  {
    type: 'phone number',
    kind: 'personal',
    pattern: /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w.-])/g,
  },
];

/** Every built-in detector, by name: the guard's tests hold their corpus to this list. */
export const DETECTOR_TYPES: ReadonlyArray<{ readonly type: string; readonly kind: FindingKind }> = DETECTORS.map(
  (detector) => ({ type: detector.type, kind: detector.kind }),
);

const LABEL: Readonly<Record<string, string>> = {
  'email address': 'EMAIL',
  'US social security number': 'SSN',
  'card number': 'CARD',
  IBAN: 'IBAN',
  'phone number': 'PHONE',
};

/** A placeholder this guard writes: `[EMAIL-1]`. */
const PLACEHOLDER_TOKEN = /\[[A-Z_]+-\d+\]/g;

/** The kinds of secret in a text, in the order found. The values are never returned. */
export function secretsIn(text: string): string[] {
  const found: string[] = [];
  for (const detector of DETECTORS) {
    if (detector.kind !== 'secret') continue;
    for (const match of text.matchAll(detector.pattern)) {
      const value = detector.valueGroup === undefined ? match[0] : match[detector.valueGroup];
      if (value === undefined || value === '') continue;
      if (detector.confirm !== undefined && !detector.confirm(match[0], [...match])) continue;
      found.push(detector.type);
    }
  }
  return found;
}

/**
 * One guard per conversation: the same value gets the same placeholder every time it is seen, so
 * an agent can refer to "[EMAIL-1]" consistently and get the real address back when it writes. The
 * map holds real values, stays in memory, and is never returned or logged.
 */
export class TeamsGuard {
  private readonly placeholders = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /**
   * Replaces personal data with placeholders, counting each kind into `tally`. A value already
   * seen gets the placeholder it had; a placeholder is never replaced again.
   */
  public redact(text: string, tally: Record<string, number> = {}): string {
    let out = text;
    for (const detector of DETECTORS) {
      if (detector.kind !== 'personal') continue;
      out = out.replaceAll(detector.pattern, (match: string) => {
        if (/^\[[A-Z_]+-\d+\]$/.test(match)) return match;
        if (detector.confirm !== undefined && !detector.confirm(match, [match])) return match;
        tally[detector.type] = (tally[detector.type] ?? 0) + 1;
        return this.placeholderFor(detector.type, match);
      });
    }
    return out;
  }

  /** Puts real values back for this guard's placeholders. One it never issued is left as written. */
  public restore(text: string): string {
    return text.replaceAll(PLACEHOLDER_TOKEN, (placeholder) => this.originals.get(placeholder) ?? placeholder);
  }

  private placeholderFor(type: string, value: string): string {
    const known = this.placeholders.get(value);
    if (known !== undefined) return known;
    const label = LABEL[type] ?? type.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_');
    const next = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, next);
    const placeholder = `[${label}-${next}]`;
    this.placeholders.set(value, placeholder);
    this.originals.set(placeholder, value);
    return placeholder;
  }
}
