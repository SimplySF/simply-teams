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
import { normalizeChat, normalizeMessage, normalizeSearchHit, renderSummary } from '../src/messages.js';

const TEAM = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc123def@thread.tacv2';
const CHAT = '19:meeting_abc@thread.v2';

describe('normalizeMessage', () => {
  it('renders a chat message into the shared shape with a ref that fetches it again', () => {
    const message = normalizeMessage({
      id: '1729512345678',
      messageType: 'message',
      chatId: CHAT,
      createdDateTime: '2026-10-21T14:03:00Z',
      lastEditedDateTime: '2026-10-21T14:05:00Z',
      from: { user: { id: 'u1', displayName: 'Ada\u001b[31m Lovelace' } },
      body: { contentType: 'html', content: '<p>See <attachment id="f1"></attachment></p>' },
      attachments: [
        { id: 'f1', contentType: 'reference', name: 'spec.pdf', contentUrl: 'https://contoso.sharepoint.com/spec.pdf' },
      ],
      webUrl: 'https://teams.microsoft.com/l/message/x/1',
    });

    expect(message).toStrictEqual({
      ref: `${CHAT}/1729512345678`,
      id: '1729512345678',
      kind: 'message',
      chatId: CHAT,
      channel: undefined,
      replyToId: undefined,
      from: { name: 'Ada[31m Lovelace', userId: 'u1' },
      createdAt: '2026-10-21T14:03:00Z',
      editedAt: '2026-10-21T14:05:00Z',
      deleted: false,
      subject: undefined,
      text: 'See [attachment: spec.pdf]',
      attachments: [{ name: 'spec.pdf', kind: 'file', url: 'https://contoso.sharepoint.com/spec.pdf' }],
      webUrl: 'https://teams.microsoft.com/l/message/x/1',
    });
  });

  it('gives a channel reply a ref that names its root', () => {
    const message = normalizeMessage({
      id: '9',
      replyToId: '1',
      channelIdentity: { teamId: TEAM, channelId: CHANNEL },
      body: { contentType: 'html', content: 'ok' },
    });
    expect(message.ref).toBe(`${TEAM}/${CHANNEL}/1/9`);
    expect(message.channel).toStrictEqual({ teamId: TEAM, channelId: CHANNEL });
  });

  it('marks system events and names them, with no sender', () => {
    const message = normalizeMessage({
      id: '5',
      chatId: CHAT,
      messageType: 'systemEventMessage',
      from: null,
      body: { contentType: 'html', content: '<systemEventMessage/>' },
      eventDetail: { '@odata.type': '#microsoft.graph.callEndedEventMessageDetail' },
    });
    expect(message).toMatchObject({ kind: 'event', text: '[event: callEnded]', from: undefined });
  });

  it('keeps a deleted message in place with no text', () => {
    const message = normalizeMessage({
      id: '6',
      chatId: CHAT,
      deletedDateTime: '2026-10-21T00:00:00Z',
      body: { content: '<p>secret</p>' },
    });
    expect(message).toMatchObject({ deleted: true, text: '' });
  });

  it('labels quoted replies and cards rather than dropping them', () => {
    const message = normalizeMessage({
      id: '7',
      chatId: CHAT,
      body: {
        contentType: 'html',
        content: '<attachment id="q"></attachment><p>agreed</p><attachment id="c"></attachment>',
      },
      attachments: [
        { id: 'q', contentType: 'messageReference' },
        { id: 'c', contentType: 'application/vnd.microsoft.card.adaptive' },
      ],
    });
    expect(message.text).toBe('[quoted message]\nagreed\n[card]');
    expect(message.attachments.map((attachment) => attachment.kind)).toStrictEqual(['reference', 'card']);
  });
});

describe('search hits', () => {
  it('renders the highlighted summary', () => {
    expect(renderSummary('…the <c0>release</c0> freeze<ddd/> &amp; more')).toBe('…the **release** freeze… & more');
  });

  it("prefers the hit's Teams link, so a channel reply's ref names its root", () => {
    const hit = normalizeSearchHit({
      summary: '<c0>deploy</c0>',
      resource: {
        id: '9',
        channelIdentity: { teamId: TEAM, channelId: CHANNEL },
        from: { emailAddress: { name: 'Ada', address: 'ada@contoso.com' } },
        webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/9?groupId=${TEAM}&parentMessageId=1`,
      },
    });
    expect(hit).toMatchObject({
      ref: `${TEAM}/${CHANNEL}/1/9`,
      from: { name: 'Ada', email: 'ada@contoso.com' },
      summary: '**deploy**',
    });
  });

  it('falls back to IDs when the hit links somewhere other than Teams', () => {
    // The documented example response links chat hits to Outlook on the web.
    const hit = normalizeSearchHit({
      resource: { id: '42', chatId: CHAT, channelIdentity: {}, webUrl: 'https://outlook.office365.com/owa/?ItemID=x' },
    });
    expect(hit).toMatchObject({ ref: `${CHAT}/42`, chatId: CHAT, channel: undefined });
  });
});

describe('normalizeChat', () => {
  it('previews the last message on one line and corrects the meeting placeholder type', () => {
    const chat = normalizeChat({
      id: '19:meeting_x@thread.v2',
      chatType: 'unknownFutureValue',
      topic: 'Sprint\nreview',
      lastMessagePreview: {
        createdDateTime: '2026-10-21T10:00:00Z',
        body: { contentType: 'html', content: '<p>line one</p><p>line two</p>' },
        from: { user: { displayName: 'Ada' } },
      },
    });
    expect(chat).toMatchObject({
      ref: '19:meeting_x@thread.v2',
      type: 'meeting',
      topic: 'Sprint review',
      lastMessage: { from: 'Ada', at: '2026-10-21T10:00:00Z', preview: 'line one line two' },
    });
  });
});
