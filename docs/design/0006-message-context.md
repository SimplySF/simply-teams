# 0006 — Message context: the threads behind a question, in one call

**Status:** Implemented, unreleased
**Package:** `packages/simply-teams-core`, `packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-23

## Problem

The reason this tool exists (0001) is to let an agent find the conversation behind a change. With
[0002](0002-read-commands.md) that takes several steps: `message search` returns snippets with no
body, the agent guesses which hits matter, and calls `message view --context` once per hit. Five
hits are six calls, each answer is a separate payload, and two hits from the same thread fetch it
twice. An agent on a slow or throttled connection pays for every round trip, and one that is
economical with calls opens too few hits and misses the thread where the decision was made.

The equivalent for Confluence is one search and one page read. Teams needs the same shape: one
call that returns the relevant conversations, with their text, bounded in size.

## Decision

Add `teams message context <query>` and the tool `teams_message_context`. It searches, groups the
hits into threads, fetches each thread with the messages around the hit, and returns them oldest
first, in the search's relevance order, within a character budget. Everything it does is 0002's
`searchMessages` and `viewMessage`; it adds grouping, ordering and a budget, in core, so the CLI
and the MCP server return the same thing.

## Behavior

### Command

| CLI                                       | MCP tool                | Scopes                                 |
| ----------------------------------------- | ----------------------- | -------------------------------------- |
| `teams message context <query> [filters]` | `teams_message_context` | `Chat.Read`, `ChannelMessage.Read.All` |

The query and filters are `message search`'s (`--from`, `--since`, `--until`, `--mentions-me`), plus:

| Flag / input               | Default     | Meaning                                                                                      |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `--threads` / `threads`    | 5 (max 20)  | How many threads to return, in relevance order                                               |
| `--context` / `context`    | 10 (max 50) | Messages around each hit: a channel thread's root and replies, a chat's messages either side |
| `--max-chars` / `maxChars` | 24000       | A ceiling on the text returned, so an agent's context is not flooded                         |

### What comes back

```ts
interface MessageContext {
  query: string; // the KQL sent
  searched: number; // hits the search returned
  searchComplete: boolean; // false when more hits were available than were read
  threads: ContextThread[]; // in relevance order of their first hit
  skipped: number; // threads beyond `threads`, or that could not be read or fitted
  unplaced: number; // hits whose ref names no message, so they belong to no thread
  truncated: boolean; // the budget cut something
}
interface ContextThread {
  ref: string; // a ref `message view` accepts: the first hit
  kind: 'channel' | 'chat';
  where?: string; // "Team / Channel", or a chat's topic or type, when it could be named
  hits: number; // matching messages among `messages`
  hitIds: string[]; // which of `messages` matched, so a renderer can mark them
  messages: TeamsMessage[]; // oldest first, 0002's shape, text already rendered
  truncated: boolean; // messages dropped from this thread to fit the budget
  warnings: string[]; // from the view, e.g. a thread with more replies than were read
  webUrl?: string;
}
```

- **Grouping.** A channel hit belongs to its root post's thread (a reply's ref names its root, 0002).
  Every hit in a chat belongs to that chat; the view is taken around the first hit. Threads are
  ordered by their first hit's position in the search results, which is Graph's relevance order.
- **Reading.** Each thread is one `viewMessage(firstHit, context)`: the root and the replies around
  a channel hit, or the messages either side of a chat hit. Threads are read one at a time, because
  Graph throttles per app and tenant. A thread that cannot be read (a meeting chat the user has
  left answers 403, a message deleted since it was indexed answers 404) is skipped and counted, not
  fatal. A channel hit whose ref names only the message is placed in its thread before grouping,
  from the channel's newest posts (see 0002, _Search hits_): a reply read as a root also answers
  404, and until 2026-10-29 every such hit was skipped as "deleted", so a thread with more matching
  replies than the `threads` cap vanished whole. Two replies to one post now make one thread. Any other failure, a 429 or 5xx that outlasted the retries included, fails the call, so a
  throttled tenant is reported rather than hidden behind "more threads not shown".
- **Naming.** `where` is best effort: team and channel names come from `team list` and
  `channel list`, a chat's topic or type from `GET /chats/{id}`, each fetched once per run. A
  lookup that fails leaves `where` unset; it never fails the call.
- **Budget.** Text is counted as it is added. A thread that would cross `maxChars` loses the message
  furthest from any hit, one at a time, until it fits or holds only its hits; a thread whose root
  and last reply both match loses its middle. One whose hits alone cannot fit is skipped. The result
  and the thread both say when that happened. A thread's `hits` count only the hits it shows: a
  later hit in a chat can fall outside the window read around the first.
- **Rendering.** The CLI prints each thread as a transcript (0002's `renderTranscript`) under a
  heading naming where it is and how many messages matched, with the matching messages marked
  `◀`, and ends with a line such as `3 threads from 11 hits (2 more threads not shown).` Under
  `--json`, and from the tool, the object above is returned; the MCP server cleans it as it cleans
  everything (0005).

### Errors

The same as search: without `ChannelMessage.Read.All`, Graph refuses the search and the call
fails with that 403. A bad date or an out-of-range `threads`/`context` is a `ConfigError`.

## Alternatives considered

- **`message search --expand`.** The same behaviour as a flag on search. Rejected: the result shape
  is different enough (threads, not hits) that a flag would make `search`'s output two things, and
  an agent reads a tool's name before its options.
- **Full-thread reads with no budget.** A thread with 300 replies would swamp the result; the
  budget keeps one call's answer the size an agent can use, and `message view --context` is still
  there for the whole thread.
- **Fetching threads in parallel.** Faster, but Graph's per-app throttling on chat and channel
  reads would turn five parallel reads into 429s on a busy tenant (0002's reasoning for replies).
- **Ranking by date instead of relevance.** The search already ranks; reordering by date would put
  the most relevant thread last.

## Implementation plan

1. Core `message-context.ts`: `gatherMessageContext(graph, text, filters, options)`, the grouping
   (`threadKey`), the naming cache, the budget, and the types; exported from `index.ts`.
2. CLI `commands/teams/message/context.ts`; `renderThread` in `shared/message-output.ts`.
3. MCP `teams_message_context`.
4. Docs: this record, the READMEs, the MCP guide's tool table.

## Testing

- **core** (local server): hits in two channel threads and a chat group into three threads in
  relevance order; a reply hit reads its root's thread; a chat with two hits is read once around the
  first; `threads` limits and counts the rest as skipped; the budget trims a long thread around its
  hits and marks it; a thread that answers 403 is skipped and counted; names are resolved once per
  team and chat and a failed lookup leaves `where` unset; the scopes named are the search's and the
  view's.
- **CLI** (nock): renders threads with the hits marked and the closing line; `--json` returns the
  object; `--clean` applies.
- **MCP**: the tool returns what the CLI returns and is cleaned; the parity check.

## Open questions

- **Chat threads around several hits.** A chat with hits far apart is read around the first only.
  Reading a window around each would be more complete and more calls; wait for a real case.
- **Relevance across threads.** A thread with five hits ranks where its first hit ranks. Weighting by
  hit count is easy to add once there is a reason to.
