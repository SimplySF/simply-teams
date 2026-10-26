# 0007 — Searching chats before an administrator has consented

**Status:** Implemented, unreleased
**Package:** `packages/simply-teams-core`, `packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-26

## Problem

Graph's message search refuses every query until a tenant administrator has consented to
`ChannelMessage.Read.All`, chats included ([0001](0001-teams-client-core-and-auth.md)). Until then
`message search` and `message context` ([0006](0006-message-context.md)) fail outright, and the
only way to read a chat is to already know which one (`chat messages`). [0002](0002-read-commands.md)
left a chat-only search as an open question, noting that consent "can take weeks".

In a government tenant that is the expected case, not the exception. A tool that an agent cannot
use for its first month is a tool nobody sets up.

## Decision

When Graph refuses the search for want of `ChannelMessage.Read.All`, search the user's recent
chats instead, on the client, with the `Chat.Read` scope a user can grant for themselves. The
result has the same shape, says plainly that channels were not searched, and is bounded: the most
recent chats, a page of messages each. `--chats-only` asks for it outright. Channels join the
search the moment consent lands, with no change to how the tool is called.

## Behavior

### When it applies

| Situation                                                                                                                                                                                                   | What `message search` and `message context` do            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Graph search succeeds                                                                                                                                                                                       | as before; `scope: "all"`                                 |
| The token for the search scopes cannot be had silently (the broker reports consent is missing), or the token's scope list lacks `ChannelMessage.Read.All`, or Graph answers 403 naming it (an opaque token) | the chat scan, `scope: "chats"`, with a `note` saying why |
| `--chats-only` / `chatsOnly`                                                                                                                                                                                | the chat scan without trying Graph search first           |
| Graph search fails for any other reason                                                                                                                                                                     | that failure, as before                                   |

### The chat scan

| Option                 | Default      | Meaning                                                                |
| ---------------------- | ------------ | ---------------------------------------------------------------------- |
| `--chats` / `chats`    | 20 (max 100) | How many of the most recent chats to read                              |
| `--since` and the rest | as search    | `since` bounds each chat read; the other filters apply to each message |

- Chats are read most recently active first (`chat list`'s order), one at a time, up to 200
  messages each (one page bound, `since` permitting). Reading stops early in a chat once it is
  older than `since`.
- **Matching** is on words, not KQL: every word of the query must appear in the message's text or
  subject, case-insensitively. A KQL term in the query (`from:x`, `sent>=…`, `AND`) is dropped
  rather than matched literally, and the note says so; a query that was only KQL, with no filter,
  is refused. `--from` matches the sender's name, or the words of an address's local part, since
  chat messages carry no address; `--until` is a whole day, as Graph's `sent<=` is; `--mentions-me`
  an `@` followed by the signed-in user's name.
- **Hits** have 0002's search-hit shape, so `message view`, `message context` and the renderers
  take them unchanged. The `summary` is a window of the message around its first match, with the
  matched words in `**bold**` as Graph's summaries are. Hits come newest first, since there is no
  relevance to rank by, and `complete` is false when a bound was hit: more chats than were read,
  a chat longer than one page, or more hits than `limit`. Chats that could not be read are counted in
  the note.
- `message context` reads the hit threads as 0006 describes; chat hits need only `Chat.Read`.

### What the caller is told

`SearchResult` and `MessageContext` gain `scope` (`"all"` or `"chats"`) and, for a chat scan,
`note`, one sentence such as: `Channels were not searched: ChannelMessage.Read.All is not granted
to this app. The 20 most recent chats were read instead, up to 200 messages each; KQL operators in
the query were ignored.` The CLI prints the note before the results; the MCP result carries it,
and the tools' descriptions say the fallback exists so an agent does not retry the search.

### Errors

An empty query with no filter is refused before any request, as search refuses it. A chat that
cannot be read (a meeting chat the user has left, 403) is skipped, not fatal.

## Alternatives considered

- **Do nothing until consent.** 0002's position. Rejected now that the government timeline is
  known: weeks without a working search is the difference between the tool being adopted or not.
- **Fall back for every search failure.** A 5xx or a network failure says nothing about consent;
  masking it with a slower, narrower search would hide the real problem. Only the consent refusal
  falls back, and the refusal is specific: Graph names the scope.
- **Match KQL locally.** A query parser for `from:`, `sent>=`, `IsMentioned:` and phrases is more
  code than the fallback deserves. The flags cover the documented filters; free-text words are
  what people and agents actually type.
- **Rank by relevance.** There is nothing to rank by but word counts, and a wrong ranking is
  worse than none. Newest first is honest and is what a person scrolling their chats sees.
- **Read channels through `channel messages` when the scope is missing.** That endpoint needs the
  same scope; nothing about channels is reachable without it.

## Implementation plan

1. Core `chat-search.ts`: `searchChats(graph, text, filters, options)`; word matching, the
   summary window, the bounds and the note.
2. Core `search.ts`: `SearchOptions` (`chatsOnly`, `chats`) and `searchMessages`, which asks
   `GraphClient.consented(SCOPES.search)` first — a silent token request, since with the broker a
   missing consent fails at the token, never at Graph — and falls back on a `false`, or on Graph's
   refusal naming the scope when the token is opaque. `operations.ts` keeps the Graph search as
   `searchGraph`; `SearchResult` gains `scope` and `note`.
3. Core `message-context.ts`: `ContextOptions.search` passed through; `MessageContext.scope`/`note`.
4. CLI: `fallbackFlags` (`--chats-only`, `--chats`) on `message search` and `message context`;
   the note printed first.
5. MCP: `chatsOnly` and `chats` inputs on both tools; descriptions mention the fallback.
6. Docs: this record, the credentials and MCP guides, the READMEs.

## Testing

- **core/chat-search** (local server): every query word must match, case-insensitively; a KQL
  term is dropped; `--from` matches name and address; `--until` and `--mentions-me`; hits newest
  first with a bolded summary and a `ref` `message view` accepts; the chat and per-chat bounds set
  `complete: false`; a 403 chat is skipped; an empty query is refused before any request; only
  `Chat.Read` and `User.Read` are asked for.
- **core/search**: a token that cannot be had silently for the search scopes falls back before Graph
  is asked; a token holding them searches Graph; an opaque token's 403 naming the scope falls back
  and any other failure does not; `chatsOnly` skips Graph search.
- **core/message-context**: threads come from chat hits under the fallback, and the note is carried.
- **CLI** (nock): `--chats-only` prints the note then the hits; the fallback on a 403.
- **MCP**: the inputs reach core; the result carries `scope` and `note`.

## Open questions

- **Group chats with hundreds of messages.** One page (200) per chat bounds cost; a `--deep` to
  read further is easy to add when someone needs it.
- **Shared channels and meetings** the user is in but not a member of: not reached by `/me/chats`;
  no plan until consent is in place anyway.
