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
import { htmlToText } from '../src/html-text.js';

describe('htmlToText', () => {
  it('turns paragraphs and breaks into lines, collapsing whitespace', () => {
    expect(htmlToText('<p>first   line</p><p>second<br>third</p>')).toBe('first line\n\nsecond\nthird');
  });

  it('renders mentions, emphasis, and emoji', () => {
    expect(
      htmlToText(
        '<p><at id="0">Ada Lovelace</at> this is <strong>done</strong>, <em>mostly</em> <emoji alt="🎉"></emoji></p>',
      ),
    ).toBe('@Ada Lovelace this is **done**, _mostly_ 🎉');
  });

  it('keeps both the text and the URL of a link whose text differs', () => {
    expect(htmlToText('<a href="https://example.com/runbook">runbook</a>')).toBe(
      '[runbook](https://example.com/runbook)',
    );
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
  });

  it('fences code blocks and keeps their whitespace', () => {
    const html =
      '<codeblock class="language-ts"><code>if (x) {\n  run();\n}</code></codeblock><p>and <code>npm test</code></p>';
    expect(htmlToText(html)).toBe('```\nif (x) {\n  run();\n}\n```\n\nand `npm test`');
  });

  it('quotes blockquotes and nests them', () => {
    expect(htmlToText('<blockquote><p>outer</p><blockquote>inner</blockquote></blockquote>')).toBe(
      '> outer\n>\n> > inner',
    );
  });

  it('renders ordered and unordered lists', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>')).toBe(
      '- one\n- two\n\n1. first\n2. second',
    );
  });

  it('decodes entities, named and numeric', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600;&nbsp;f</p>')).toBe(
      'a & b <c> "d" \'e\' 😀 f',
    );
  });

  it('labels attachments from the message, and images it cannot show', () => {
    const label = (id: string): string | undefined => (id === 'a1' ? '[attachment: spec.pdf]' : undefined);
    expect(
      htmlToText('<p>see <attachment id="a1"></attachment> and <img src="https://x/y.png"></p>', 'html', label),
    ).toBe('see [attachment: spec.pdf] and [image]');
    expect(htmlToText('<img itemtype="http://schema.skype.com/Emoji" alt="👍" src="x">')).toBe('👍');
  });

  it('strips what could rewrite a terminal or smuggle hidden text', () => {
    // Built from a code point so this file holds no live bidi character itself.
    const rlo = String.fromCodePoint(0x20_2e);
    const hostile = `<p>ok\u001b[2K\u001b[1Agone${rlo}evil\u{E0041}</p>`;
    expect(htmlToText(hostile)).toBe('ok[2K[1Agoneevil');
  });

  it('drops scripts and styles, and tolerates stray or unclosed tags', () => {
    expect(htmlToText('<style>p{}</style><p>kept</div><b>bold')).toBe('kept**bold**');
  });

  it('passes text bodies through, still stripped', () => {
    expect(htmlToText('plain <b>not markup</b>\u0007', 'text')).toBe('plain <b>not markup</b>');
  });
});
