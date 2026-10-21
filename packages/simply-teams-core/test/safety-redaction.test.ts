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
import { collectSecrets, redactSecrets, sanitiseDeep, secretValues } from '../src/redaction.js';
import { stripControl, stripControlOneLine } from '../src/text.js';

const TOKEN = 'eyJ0eXAiOiJKV1QiLCJub25jZSI6';

describe('redaction', () => {
  it('collects only values long enough to be a credential', () => {
    expect(collectSecrets(['short', TOKEN, undefined])).toStrictEqual(new Set([TOKEN]));
  });

  it('reads the token out of an environment', () => {
    expect(secretValues({ TEAMS_ACCESS_TOKEN: TOKEN })).toStrictEqual(new Set([TOKEN]));
  });

  it('blanks a credential wherever it appears in a message', () => {
    expect(redactSecrets(`sent ${TOKEN} twice: ${TOKEN}`, [TOKEN])).toBe('sent <redacted> twice: <redacted>');
  });

  it('applies the same guards to a nested response body as to the message', () => {
    // A body that went out untouched is a disclosure whenever the far side echoes the token back.
    expect(sanitiseDeep({ message: { errors: [`${TOKEN} rejected`] } }, [TOKEN])).toStrictEqual({
      message: { errors: ['<redacted> rejected'] },
    });
  });

  it('bounds the walk rather than trusting the body to be shallow', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 20; index += 1) deep = { deep };
    expect(() => sanitiseDeep(deep, [])).not.toThrow();
  });
});

describe('control-character stripping', () => {
  it('removes an escape sequence that could overwrite what was already printed', () => {
    expect(stripControl('ok\u001B[2Kfaked')).toBe('ok[2Kfaked');
  });

  it('removes a bare carriage return, which rewrites the line with no escape at all', () => {
    // Everything before it is overwritten on screen but still reaches a caller reading the stream.
    expect(stripControl('shown\rhidden')).toBe('shownhidden');
  });

  it('keeps the newline and tab this renderer emits', () => {
    expect(stripControl('a\n\tb')).toBe('a\n\tb');
  });

  it('removes invisible characters that smuggle text past a reader', () => {
    expect(stripControl('Done\u{E0041}\u200B')).toBe('Done');
  });

  it('collapses to one line where a newline is itself the attack', () => {
    expect(stripControlOneLine('first\nsecond  third')).toBe('first second third');
  });
});
