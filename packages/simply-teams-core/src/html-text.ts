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

import { stripControl } from './text.js';

/**
 * Teams message HTML to plain text with light Markdown (design 0002, Rendering a body).
 *
 * A small tree builder rather than a real HTML parser: Teams emits a narrow, well-formed subset,
 * and a dependency is a poor trade for tolerating markup it does not send. Anything unexpected
 * still degrades to its text content, so nothing is lost, only left unformatted.
 */

interface Element {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Node[];
}
type Node = Element | string;

/** Elements that never have content, so they must not be pushed onto the open-element stack. */
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'col', 'wbr', 'source']);

/** Elements that start and end a line of their own. */
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'tr',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Resolves an `<attachment id>` to its label, from the message's attachment list. */
export type AttachmentLabel = (id: string) => string | undefined;

export function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10_ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1];
    if (name !== undefined) attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parse(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-z][\w:-]*)([^>]*)>|[^<]+|</gi)) {
    const [token, closing, rawTag, rest = ''] = match;
    const parent = stack.at(-1) ?? root;
    if (token.startsWith('<!--')) continue;
    if (rawTag === undefined) {
      parent.children.push(decodeEntities(token));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing === '/') {
      // Close the nearest matching element; a stray closing tag with no opener is ignored.
      const at = stack.findLastIndex((element) => element.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const element: Element = { tag, attrs: parseAttributes(rest), children: [] };
    parent.children.push(element);
    if (!VOID.has(tag) && !rest.trimEnd().endsWith('/')) stack.push(element);
  }
  return root;
}

function textOf(node: Node): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}

interface Context {
  readonly attachment: AttachmentLabel;
  readonly pre: boolean;
}

/** Renders inline content, collapsing whitespace the way a browser would outside `<pre>`. */
function renderChildren(element: Element, context: Context): string {
  return element.children.map((child) => render(child, context)).join('');
}

function block(text: string): string {
  return `\n${text.trim()}\n`;
}

function prefixLines(text: string, prefix: string, rest = prefix): string {
  return text
    .trim()
    .split('\n')
    .map((line, index) => `${index === 0 ? prefix : rest}${line}`.trimEnd())
    .join('\n');
}

type Renderer = (element: Element, context: Context) => string;

/** Wraps non-empty inline content in a Markdown marker; empty emphasis renders as nothing. */
function wrap(marker: string): Renderer {
  return (element, context) => {
    const text = renderChildren(element, context).trim();
    return text === '' ? '' : `${marker}${text}${marker}`;
  };
}

function renderLink(element: Element, context: Context): string {
  const text = renderChildren(element, context).trim();
  const href = element.attrs.href ?? '';
  if (href === '' || href === text) return text === '' ? href : text;
  return text === '' ? href : `[${text}](${href})`;
}

function renderCodeBlock(element: Element, context: Context): string {
  const code = renderChildren(element, { ...context, pre: true }).replace(/^\n+|\s+$/g, '');
  return `\n\`\`\`\n${code}\n\`\`\`\n`;
}

function renderList(element: Element, context: Context): string {
  const items = element.children.filter((child): child is Element => typeof child !== 'string' && child.tag === 'li');
  const lines = items.map((item, index) =>
    prefixLines(
      renderChildren(item, context).replaceAll(/\n{2,}/g, '\n'),
      element.tag === 'ol' ? `${index + 1}. ` : '- ',
      '  ',
    ),
  );
  return block(lines.join('\n'));
}

/** How each element Teams sends is rendered; anything unlisted renders as its content. */
const RENDERERS: Readonly<Record<string, Renderer>> = {
  br: () => '\n',
  hr: () => '\n---\n',
  at: (element) => `@${textOf(element).trim()}`,
  emoji: (element) => element.attrs.alt ?? textOf(element),
  // Teams sends emoji and stickers as images; their alt text is the useful part. Other images
  // need a token to fetch, so their URL would be of no use to the reader.
  img: (element) =>
    /emoji/i.test(element.attrs.itemtype ?? '') && element.attrs.alt !== undefined ? element.attrs.alt : '[image]',
  attachment: (element, context) => context.attachment(element.attrs.id ?? '') ?? '[attachment]',
  a: renderLink,
  strong: wrap('**'),
  b: wrap('**'),
  em: wrap('_'),
  i: wrap('_'),
  code: (element, context) => (context.pre ? renderChildren(element, context) : `\`${textOf(element)}\``),
  pre: renderCodeBlock,
  codeblock: renderCodeBlock,
  blockquote: (element, context) => block(prefixLines(renderChildren(element, context), '> ')),
  ul: renderList,
  ol: renderList,
  td: (element, context) => ` ${renderChildren(element, context).trim()} |`,
  th: (element, context) => ` ${renderChildren(element, context).trim()} |`,
  tr: (element, context) => block(`|${renderChildren(element, context)}`),
  script: () => '',
  style: () => '',
};

function render(node: Node, context: Context): string {
  if (typeof node === 'string') return context.pre ? node : node.replaceAll(/\s+/g, ' ');
  const renderer = RENDERERS[node.tag];
  if (renderer !== undefined) return renderer(node, context);
  const inner = renderChildren(node, context);
  return BLOCK.has(node.tag) ? block(inner) : inner;
}

/**
 * Renders a message body. `contentType: 'text'` bodies are taken as-is; HTML is rendered. Either
 * way the result goes through `stripControl`, because a message body is written by anyone in
 * the chat and is the widest untrusted input this CLI handles.
 */
export function htmlToText(
  content: string,
  contentType = 'html',
  attachment: AttachmentLabel = () => undefined,
): string {
  const raw = contentType.toLowerCase() === 'html' ? render(parse(content), { attachment, pre: false }) : content;
  return stripControl(raw)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
