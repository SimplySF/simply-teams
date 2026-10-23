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
import { buildMessageBody, escapeHtml, textToHtml } from '../src/message-body.js';

describe('message bodies', () => {
  it('escapes plain text, so markup in it is shown rather than obeyed', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });

  it('keeps line breaks in plain text', () => {
    expect(textToHtml('one\ntwo\r\nthree')).toBe('one<br>two<br>three');
  });

  it('sends HTML as given', () => {
    expect(buildMessageBody({ html: '<p>Hi <strong>all</strong></p>' })).toStrictEqual({
      body: { contentType: 'html', content: '<p>Hi <strong>all</strong></p>' },
    });
  });

  it('puts each mention at the start and links it in mentions[]', () => {
    const body = buildMessageBody({ text: 'take a look' }, [
      { id: 'u1', name: 'Ada <Lovelace>' },
      { id: 'u2', name: 'Bo' },
    ]);
    expect(body.body.content).toBe('<at id="0">Ada &lt;Lovelace&gt;</at> <at id="1">Bo</at> take a look');
    expect(body.mentions).toStrictEqual([
      {
        id: 0,
        mentionText: 'Ada <Lovelace>',
        mentioned: { user: { id: 'u1', displayName: 'Ada <Lovelace>', userIdentityType: 'aadUser' } },
      },
      { id: 1, mentionText: 'Bo', mentioned: { user: { id: 'u2', displayName: 'Bo', userIdentityType: 'aadUser' } } },
    ]);
  });

  it('refuses an empty message, and one given as both text and HTML', () => {
    expect(() => buildMessageBody({ text: '   ' })).toThrow(ConfigError);
    expect(() => buildMessageBody({ text: 'a', html: '<p>a</p>' })).toThrow(/not both/);
  });
});
