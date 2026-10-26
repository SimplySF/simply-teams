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
import { channelMessageRef, chatMessageRef, parseRef } from '../src/refs.js';

const TEAM = '11111111-2222-3333-4444-555555555555';
const TENANT = '99999999-2222-3333-4444-555555555555';
const MEETING_CHAT = '19:meeting_MTdlMDMxNGItNjdlMy00NmI2@thread.v2';
const CHANNEL = '19:abc123def@thread.tacv2';

const ALL = ['chat', 'chatMessage', 'team', 'channel', 'channelMessage'] as const;

describe('parseRef: Teams links', () => {
  it('reads a chat message link in the form Graph returns as webUrl', () => {
    // Shape observed in the 2026-10-21 probe, IDs replaced.
    const link =
      `https://teams.microsoft.com/l/message/${encodeURIComponent(MEETING_CHAT)}/1729512345678` +
      `?context=%7b%22contextType%22%3a%22chat%22%7d&tenantId=${TENANT}`;
    expect(parseRef(link, ALL)).toStrictEqual({
      kind: 'chatMessage',
      chatId: MEETING_CHAT,
      messageId: '1729512345678',
    });
  });

  it('reads a chat link', () => {
    const link = `https://teams.microsoft.com/l/chat/${encodeURIComponent(MEETING_CHAT)}/0?tenantId=${TENANT}`;
    expect(parseRef(link, ALL)).toStrictEqual({ kind: 'chat', chatId: MEETING_CHAT });
  });

  it('reads a channel root post, which names itself as its parent', () => {
    const link = `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1700000000001?tenantId=${TENANT}&groupId=${TEAM}&parentMessageId=1700000000001`;
    expect(parseRef(link, ALL)).toStrictEqual({
      kind: 'channelMessage',
      teamId: TEAM,
      channelId: CHANNEL,
      messageId: '1700000000001',
    });
  });

  it('reads a channel reply, keeping its root so it can be fetched', () => {
    const link = `https://teams.cloud.microsoft/l/message/${encodeURIComponent(CHANNEL)}/1700000000009?groupId=${TEAM}&parentMessageId=1700000000001`;
    expect(parseRef(link, ALL)).toStrictEqual({
      kind: 'channelMessage',
      teamId: TEAM,
      channelId: CHANNEL,
      messageId: '1700000000009',
      rootId: '1700000000001',
    });
  });

  it('reads channel and team links, and sovereign hosts', () => {
    expect(
      parseRef(`https://gov.teams.microsoft.us/l/channel/${encodeURIComponent(CHANNEL)}/General?groupId=${TEAM}`, ALL),
    ).toStrictEqual({
      kind: 'channel',
      team: { id: TEAM },
      channel: { id: CHANNEL },
    });
    expect(
      parseRef(`https://teams.microsoft.com/l/team/${encodeURIComponent(CHANNEL)}/conversations?groupId=${TEAM}`, ALL),
    ).toStrictEqual({
      kind: 'team',
      team: { id: TEAM },
    });
  });

  it('reads a meeting join link as its meeting chat (design 0008)', () => {
    const link =
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7B%22Tid%22%3A%22t%22%7D';
    expect(parseRef(link, ['chat'])).toStrictEqual({ kind: 'chat', chatId: '19:meeting_abc@thread.v2' });
    expect(() => parseRef('https://teams.microsoft.com/l/meetup-join/nope/0', ['chat'])).toThrow(ConfigError);
  });

  it('refuses a link from any other host', () => {
    expect(() => parseRef('https://teams.evil.example/l/chat/19%3Ax%40thread.v2/0', ALL)).toThrow(
      /not a Microsoft Teams host/,
    );
  });

  it('refuses a channel link with no team', () => {
    expect(() => parseRef(`https://teams.microsoft.com/l/channel/${encodeURIComponent(CHANNEL)}/General`, ALL)).toThrow(
      /groupId/,
    );
  });
});

describe('parseRef: refs this CLI prints', () => {
  it('round-trips chat and channel message refs', () => {
    expect(parseRef(chatMessageRef(MEETING_CHAT, '42'), ALL)).toStrictEqual({
      kind: 'chatMessage',
      chatId: MEETING_CHAT,
      messageId: '42',
    });
    expect(parseRef(channelMessageRef(TEAM, CHANNEL, '9', '1'), ALL)).toStrictEqual({
      kind: 'channelMessage',
      teamId: TEAM,
      channelId: CHANNEL,
      rootId: '1',
      messageId: '9',
    });
    expect(channelMessageRef(TEAM, CHANNEL, '1', '1')).toBe(`${TEAM}/${CHANNEL}/1`);
  });

  it('takes teams and channels by name or ID', () => {
    expect(parseRef('Platform Engineering', ['team'])).toStrictEqual({
      kind: 'team',
      team: { name: 'Platform Engineering' },
    });
    expect(parseRef('Platform/General', ['channel'])).toStrictEqual({
      kind: 'channel',
      team: { name: 'Platform' },
      channel: { name: 'General' },
    });
    expect(parseRef(`${TEAM}/${CHANNEL}`, ['channel'])).toStrictEqual({
      kind: 'channel',
      team: { id: TEAM },
      channel: { id: CHANNEL },
    });
  });

  it('insists on IDs for channel messages, which have no names', () => {
    expect(() => parseRef('Platform/General/1700000000001', ALL)).toThrow(/teamId\/channelId\/messageId/);
  });

  it('says what was wanted when the kind does not fit the command', () => {
    expect(() => parseRef(MEETING_CHAT, ['channel'])).toThrow(/That is a chat, but this needs a channel/);
  });

  it('refuses empty input and empty parts', () => {
    expect(() => parseRef('  ', ALL)).toThrow(ConfigError);
    expect(() => parseRef(`${TEAM}//x`, ALL)).toThrow(/empty part/);
  });
});
