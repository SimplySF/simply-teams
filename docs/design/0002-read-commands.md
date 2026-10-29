# 0002 — Read commands: search, messages, chats, and channels

**Status:** Implemented, unreleased (search and the channel commands not yet run against real Graph: they need admin consent)
**Package:** `packages/simply-teams-core`, `packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-21

## Problem

[0001](0001-teams-client-core-and-auth.md) delivered sign-in and nothing else. An agent still cannot
do what the tool exists for:

- find the conversation where something was decided;
- read it in full, with enough of the surrounding thread to understand it;
- follow a Teams link a developer pastes in.

## Decision

Add seven read-only commands, each with a matching MCP tool, all built on core operations:

- `message search`, `message view`;
- `chat list`, `chat messages`;
- `team list`, `channel list`, `channel messages`.

Every command returns a **normalized message shape** with the body already rendered to text, not
Graph's raw `chatMessage`. Any place that takes a chat, channel or message accepts a **Teams link**
as well as IDs. Each command requests only the scopes it needs, so the commands that need
`ChannelMessage.Read.All` fail on their own when it lacks admin consent; the rest keep working.

## Behavior

### Commands

| CLI                                    | MCP tool                 | Graph                                                                                       | Scopes                                   |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `teams message search <query>`         | `teams_message_search`   | `POST /search/query`, `entityTypes: ["chatMessage"]`                                        | `Chat.Read`, `ChannelMessage.Read.All`   |
| `teams message view <ref>`             | `teams_message_view`     | `GET /chats/{c}/messages/{m}` or `/teams/{t}/channels/{ch}/messages/{m}`, plus `…/replies`  | `Chat.Read` or `ChannelMessage.Read.All` |
| `teams chat list`                      | `teams_chat_list`        | `GET /me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc` | `Chat.Read`                              |
| `teams chat messages <chat-ref>`       | `teams_chat_messages`    | `GET /chats/{c}/messages` (newest first)                                                    | `Chat.Read`                              |
| `teams team list`                      | `teams_team_list`        | `GET /me/joinedTeams`                                                                       | `Team.ReadBasic.All`                     |
| `teams channel list <team-ref>`        | `teams_channel_list`     | `GET /teams/{t}/channels`                                                                   | `Channel.ReadBasic.All`                  |
| `teams channel messages <channel-ref>` | `teams_channel_messages` | `GET /teams/{t}/channels/{ch}/messages` (root posts)                                        | `ChannelMessage.Read.All`                |

0001's `thread view` and `open` are dropped:

- **`thread view` is folded into `message view --context`.** For a channel message that means the
  root post plus its replies; for a chat message, the messages either side of it. A separate
  command would have meant two names for the same question: "what was said around this?"
- **`open` is dropped** because every result already carries the Teams `webUrl`, and the MCP server
  could only ever return that URL anyway.

### Flags

| Command            | Flags                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `message search`   | `--from <name or email>`, `--since <date>`, `--until <date>`, `--mentions-me`, `--limit` (default 25) |
| `message view`     | `--context <n>` (default 0, max 50)                                                                   |
| `chat list`        | `--limit` (default 20)                                                                                |
| `chat messages`    | `--since <date>`, `--limit` (default 50), `--include-events`                                          |
| `channel messages` | `--since <date>`, `--limit` (default 25), `--replies` (fetches each root post's replies)              |
| all list commands  | the template's `--limit` and "Showing N … (limit reached; more available)" line                       |

The `message search` flags compile to the KQL the Teams search API documents: `from:`, `sent>=`,
`sent<=`, and `IsMentioned:true`. The query argument passes through verbatim, so an agent can still
write its own KQL, including `to:`, `hasAttachment:` and `mentions:`. A flag value containing
whitespace or KQL syntax is quoted, so it cannot inject operators.

### References: links and IDs

`refs.ts` in core parses every form a person or agent is likely to paste:

| Input                                                                                   | Resolves to                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `…/l/message/{chatId}/{messageId}?context={"contextType":"chat"}…`                      | chat message                                                   |
| `…/l/message/{channelId}/{messageId}?groupId={teamId}&parentMessageId={rootId}…`        | channel message, or a reply when `parentMessageId ≠ messageId` |
| `…/l/chat/{chatId}/0?…`                                                                 | chat                                                           |
| `…/l/channel/{channelId}/{name}?groupId={teamId}…`                                      | channel                                                        |
| `19:…@thread.v2` or `19:…@unq.gbl.spaces`                                               | chat ID                                                        |
| `19:…@thread.tacv2` or `19:…@thread.skype`, together with a team                        | channel ID                                                     |
| a team GUID, or a team display name (exact match, case-insensitive, among joined teams) | team                                                           |

Accepted hosts are `teams.microsoft.com` and `teams.cloud.microsoft`, plus the sovereign hosts
(`gov.teams.microsoft.us`, `dod.teams.microsoft.us`) for those clouds. A link from another host,
or one whose kind does not fit the command (a chat link given to `channel messages`, say), is a
`ConfigError` that says what was expected. The `webUrl` formats above were observed in the
2026-10-21 probe. The channel forms follow Microsoft's documented deep-link format and are not yet
observed live, because channel reads need the admin-consented scope.

### The message shape

Every command that returns messages returns this, under `--json` and from MCP alike:

```ts
interface TeamsMessage {
  ref: string; // pass to `message view` to fetch it again; a channel reply's ref names its root
  id: string;
  kind: 'message' | 'event'; // `event` is a systemEventMessage (call started, member added, …)
  chatId?: string; // exactly one of chatId and channel is set
  channel?: { teamId: string; channelId: string };
  replyToId?: string; // channel replies only
  from?: { name?: string; userId?: string; email?: string }; // absent for system events
  createdAt: string;
  editedAt?: string;
  deleted: boolean; // a deleted message keeps its place in a thread with no text
  subject?: string;
  text: string; // body rendered to plain text plus light Markdown (see below)
  attachments: Array<{ name?: string; kind: 'file' | 'card' | 'reference' | 'other'; url?: string }>;
  webUrl?: string;
}
```

Search hits use a reduced shape, because the search API returns **no body**:
`{ ref, id, chatId?, channel?, from, createdAt, summary, webUrl? }`. Here `summary` is Graph's
highlighted snippet, with its `<c0>` match tags rendered as `**…**`. Calling `message view` on a hit
fetches the full message.

**Every result carries a `ref`** (chats, teams and channels too), and every command accepts one.
This was added during implementation: an agent should not have to rebuild
`teamId/channelId/rootId/replyId` from separate fields to follow up on a result.

- **Search hits** carry no reply-to ID. Their Teams link is read for the root post it may name, and
  otherwise the `ref` is built from the IDs. Two things learned on 2026-10-29, against a real
  tenant: the search API names the link `webLink`, not `webUrl` as a message does (the code had
  read `webUrl`, so the link was never used); and the link can be the bare
  `/l/message/{channelId}/{id}` form, with no `groupId` or `parentMessageId`, which names no root
  and would even parse as a chat message. So the link is never trusted over the IDs: it can only
  add a root. A ref that names only a reply is still usable: `message view`, `message context` and
  `message reply` find its root among the channel's newest posts (`ThreadRoots`: up to three pages
  of 50, replies expanded, read only as far as needed and once per call), because Graph serves a
  reply only under its root and answers 404 for the reply's own ID, exactly as for a deleted post.
  A reply to an older post than the scan reaches is reported as not found, with both cases named.
- **Chat message links** were checked against real data: on 2026-10-21, the parsed `webUrl` of all
  241 messages sampled from 8 chats round-tripped to the message's exact chat and message ID.

**This departs from the sibling CLIs, which return the raw API payload.** The reasons:

- **The raw body is HTML** full of `<at>`, `<attachment>` and `<emoji>` elements that the reader
  would have to parse.
- **Most of each payload is noise for an agent:** `etag`, `policyViolation`, `reactions`, and
  `eventDetail` with nested identity sets. Each message costs several times the tokens of its
  content.
- **Three shapes would otherwise leak through:** search hits, chat messages and channel messages
  are shaped differently enough that a caller would have to handle all three.

The shape is defined in core, so the CLI and MCP cannot drift apart. Each field is documented in
the CLI README.

### Rendering a body

`html-text.ts` in core is dependency-free. It handles the tags the probe observed, plus Teams'
documented elements:

| Teams HTML                       | Rendered as                                                             |
| -------------------------------- | ----------------------------------------------------------------------- |
| `<p>`, `<div>`, `<br>`           | line breaks, collapsing runs of blank lines                             |
| `<at id="n">Name</at>`           | `@Name`                                                                 |
| `<a href="u">t</a>`              | `[t](u)`, or just `u` when `t` equals it                                |
| `<code>`, `<pre>`, `<codeblock>` | `` `…` `` / fenced block                                                |
| `<blockquote>`                   | `> ` prefixed lines (Teams' reply quotes)                               |
| `<ul>`/`<ol>`/`<li>`             | `- ` / `1. ` items                                                      |
| `<strong>`/`<b>`, `<em>`/`<i>`   | `**…**`, `_…_`                                                          |
| `<emoji alt="😀">`               | the `alt` text                                                          |
| `<img>`                          | `[image]` (the URL needs a token to fetch, so it is not useful to emit) |
| `<attachment id="x">`            | `[attachment: name]`, with the name looked up in `attachments`          |
| system events (`eventDetail`)    | `[event: <type>]`, e.g. `[event: callEnded]`                            |
| anything else                    | its text content                                                        |

Entities are decoded, and the result goes through `stripControl`. Message text is the most
attacker-reachable input in this repo: anyone in any chat the user is in can write it. It is
printed only through `logSafe`. Display names and chat topics are written by their owners, so they
are stripped and kept on one line in the JSON too, not only in the terminal.

The renderer was checked against real data on 2026-10-21. Of 241 messages sampled from 8 chats
(179 of them system events), none still contained a raw tag or entity after rendering. Only counts
were printed; no message content.

### Paging and limits

- **Search** pages with `from`/`size`, 25 per page, until `moreResultsAvailable` is false or
  `--limit` is reached. The search API's `total` counts **the current page only** (a documented
  limitation), so it is never reported as a total. The search API cannot sort message hits.
- **Lists** use `GraphClient.list` and `@odata.nextLink`.
- **Chat messages** come newest first. `--since` stops paging at the first message older than the
  cutoff, rather than filtering after fetching everything.
- **`message view --context n` for a chat message** has no endpoint for "messages around X". It
  pages newest-first through the chat until it passes the target message, then takes `n` either
  side. The scan is bounded at 10 pages, about 500 messages. A message older than that is returned
  on its own, with no context and a warning, rather than by walking a years-old chat.
- **Channel posts** have no documented order, so `--since` filters within that same 10-page bound
  rather than stopping early.

### Errors

- A chat whose messages return 403 `InsufficientPrivileges` is a meeting chat the user can list but
  no longer read; the probe saw this. `chat list` lists it anyway. Reading it is an `AuthError`
  that names that case.
- Missing `ChannelMessage.Read.All` makes `message search` and the channel commands fail. The 403
  is passed through: Graph's message names the scope, as 0001 established. The CLI adds no "ask
  your admin" text, for the reason 0001 gives about agents and privilege escalation.
- **Graph mislabels some meeting chats.** Sorted by last message, `/me/chats` returns some meeting
  chats with `chatType: unknownFutureValue`. The draft proposed sending
  `Prefer: include-unknown-enum-members` to fix this. **That was wrong:** a 2026-10-21 comparison
  showed no difference with the header, and Graph never acknowledged it (`Preference-Applied` was
  absent). The header is not sent. Instead, `normalizeChat` reports a `19:meeting_…` chat with that
  placeholder as `meeting`.

## Alternatives considered

- **Return raw Graph payloads, like the siblings.** Rejected for the reasons under "The message
  shape". Raw access stays possible through core's `GraphClient`, for scripts that want it.
- **A chat-only search that needs no admin consent:** scan `/me/chats`, then each chat's
  messages, filtering on the client.
  - It would make the tool useful before an admin consents, which matters because consent can take
    weeks.
  - But its cost grows with chats × messages. Graph throttles chat-message reads per app per
    tenant, so a broad query would page slowly and hit 429s.
  - Its results would also silently differ from real search: no stemming, no attachments, no
    ranking.

  **Deferred** to an [open question](#open-questions) rather than rejected. `chat messages
--since` covers the narrow version ("what was said in this chat this week?") today.

- **Separate `thread view` and `open` commands**, as 0001 proposed. Folded or dropped, as described
  above.
- **The beta search endpoint.** It has a newer schema and more fields. v1.0 returns everything the
  hit shape needs, and 0001's rule is no beta without a reason.
- **`$expand=members` on `chat list`**, to name 1:1 chats by the other person. It is plausible, but
  it costs a much larger payload per chat, and combining it with `$expand=lastMessagePreview` is
  unverified. It is left out until it is measured. A 1:1 chat without a topic is labelled by its
  last message's sender.

## Implementation plan

1. Core:
   - `refs.ts`: parse links and IDs into `{ kind: 'chat' | 'channel' | 'chatMessage' | 'channelMessage' | 'team', … }`.
   - `html-text.ts`.
   - `messages.ts`: `TeamsMessage`, `normalizeMessage(raw)`, `normalizeSearchHit(hit)`.
   - `kql.ts`: build the query from the flags, with quoting.
   - Graph client: `get`, `post`, and a `pages()` iterator, so operations can stop paging early.
   - Operations: `searchMessages`, `viewMessage` (with context), `listChats`, `listChatMessages`,
     `listTeams`, `listChannels`, `listChannelMessages`, plus team-by-name resolution.
2. CLI: seven commands under `teams message|chat|team|channel`, rendering tables (lists) and
   transcripts (`message view`, `chat messages`) through `logSafe`.
3. MCP: seven tools, one per command, with the cross-check test updated.
4. Docs: the README is regenerated, and the credentials guide gains a "which command needs which
   scope" table.

## Testing

- **refs**:
  - every link form in the table, using the masked real `webUrl`s from the probe as fixtures;
  - sovereign hosts;
  - the wrong kind for a command, and a foreign host, are `ConfigError`s;
  - IDs with URL-encoded `:` and `@`.
- **html-text**:
  - each row of the rendering table;
  - nested lists, a quote inside a quote, and entities;
  - a hostile body (ESC sequences, bidi characters, tag-block smuggling) comes out stripped;
  - a link whose text differs from its URL keeps both visible.
- **kql**:
  - each flag compiles to the documented term;
  - values with spaces or quotes are quoted;
  - a value cannot add a term (`--from 'x OR sent>2000-01-01'`).
- **messages**:
  - normalizing chat, channel, reply, deleted and system-event messages and search hits, from
    fixtures shaped like the probe output;
  - `<c0>` highlights.
- **Operations** (local server):
  - search pages by `from`/`size` and stops on `moreResultsAvailable: false`;
  - `--since` stops paging early;
  - the context window is bounded at 10 pages, with a warning;
  - a 403 `InsufficientPrivileges` on chat messages is named;
  - every request carries the scopes in the table.
- **CLI/MCP**:
  - one command test per topic, using nock as in 0001;
  - the catalogue cross-check;
  - no command output ever contains the token.
- **Manual**: re-run against real Graph once an app registration with admin consent exists. Search
  and the channel forms of `refs` are the parts not yet seen live.

## Open questions

- **A no-admin chat search** (see Alternatives). Is it worth building, bounded by `--chats <n>`
  most-recent chats, while admin consent is pending? That depends on how long consent takes, which
  is Clay's call.
- **The maximum search page size** for `chatMessage` is unverified; 25 is the documented example
  and the safe default. Check it once search is reachable.
- **Meeting transcripts and shared files** remain out of scope, as in 0001.
- **Consented scope names must match exactly.** The 2026-10-21 probe showed the broker refusing a
  silent `Chat.Read` request, with `interaction_required`, for an app consented only for
  `Chat.ReadWrite`. A broader grant on the token does not satisfy a narrower request. The app
  registration must therefore be consented for exactly `READ_SCOPES`. Should requests fall back to
  a consented broader scope the token already lists? That would bring back the privilege creep the
  dedicated app registration is meant to avoid, so the proposed answer is no.
