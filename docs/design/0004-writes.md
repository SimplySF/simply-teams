# 0004 — Writes: posting, replying, and sending in a chat

**Status:** Implemented, unreleased (run against a real tenant on 2026-10-22; see Testing)
**Package:** `packages/simply-teams-core`, `packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-22

## Problem

[0001](0001-teams-client-core-and-auth.md) shipped read-only and left writes to "their own design
doc and the template's `--allow-writes`/`TEAMS_READ_ONLY` gating". An agent can now find the thread
where something was decided, but it cannot answer in it: the developer still has to switch to
Teams to say "deployed", reply to a question, or tell a colleague in a chat that a fix is in.

The gate is already in place: `TeamsCommand.isWrite` calls `assertWritesAllowed()`, the MCP server
registers only read tools without `--allow-writes`, and a test requires every write tool to take
`dryRun`. What is missing is the commands, the scopes they need, and a transport that will not send
a message twice.

## Decision

Add three write commands, each with a matching MCP tool registered only under `--allow-writes`:

- `channel post`: start a thread in a channel;
- `message reply`: reply in a channel thread;
- `chat send`: send in a 1:1, group, or meeting chat.

They share one core path: a **plan** (the exact request, which `--dry-run` shows) and a **send**
(which posts it once and returns the stored message in 0002's `TeamsMessage` shape). The two send
scopes stay out of `READ_SCOPES`, so writing is something a person opts into at sign-in.

## Behavior

### Commands

| CLI                                         | MCP tool              | Graph                                                  | Scope                 |
| ------------------------------------------- | --------------------- | ------------------------------------------------------ | --------------------- |
| `teams channel post <channel-ref>`          | `teams_channel_post`  | `POST /teams/{t}/channels/{c}/messages`                | `ChannelMessage.Send` |
| `teams message reply <channel-message-ref>` | `teams_message_reply` | `POST /teams/{t}/channels/{c}/messages/{root}/replies` | `ChannelMessage.Send` |
| `teams chat send <chat-ref>`                | `teams_chat_send`     | `POST /chats/{c}/messages`                             | `ChatMessage.Send`    |

Each takes the references 0002 already parses. `channel post` accepts "Team/Channel" by name.
`message reply` accepts a channel message, and a reply's ref replies to its thread, because Teams
threads are one level deep (`ref.rootId ?? ref.messageId`). A chat message given to
`message reply` is a `ConfigError` that names `teams chat send`: chats have no threads.

### The message

| Flag / input             | Meaning                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--text` / `text`        | Plain text. HTML-escaped, so `<b>` is shown, not applied; line breaks kept.                                                                                                                                                         |
| `--html` / `html`        | Teams HTML, sent as given, for formatting. Exclusive with text.                                                                                                                                                                     |
| `--mention` / `mentions` | Email, UPN, or user ID; repeatable. Resolved with `GET /users/{x}` (`User.ReadBasic.All`) and placed at the start as `<at id="n">Name</at>` with a `mentions[]` entry. An unknown one is a `ConfigError` before anything is posted. |
| `--dry-run` / `dryRun`   | Prints or returns `{ method, path, body, scopes }` and sends nothing.                                                                                                                                                               |

An empty message, or one given as both text and HTML, is a `ConfigError` before any request.
Mentions go at the start because Graph requires every `mentions[]` entry to appear in the content,
and a caller cannot be expected to write `<at id>` markup. A dry run still resolves channel names
and mentions (read scopes), but needs neither write scope.

The result is the posted message, normalized as 0002 normalizes everything, with its `ref`, so the
next step (a reply, a `message view`) needs no reshaping.

### Scopes and sign-in

| Scope                 | Used by                         | Admin consent | Permission ID                          |
| --------------------- | ------------------------------- | ------------- | -------------------------------------- |
| `ChannelMessage.Send` | `channel post`, `message reply` | no            | `ebf0f66e-9fb1-49e4-a278-222f76911cf4` |
| `ChatMessage.Send`    | `chat send`                     | no            | `116b7235-7cc6-461e-b163-8e55691d839e` |

Core exports them as `WRITE_SCOPES`. They are **not** part of `READ_SCOPES`, so `auth status` never
reports them as a gap; it reports them on their own line ("Can post") from `missingWriteScopes`.
`auth login --allow-writes` asks for them, interactively, since any user can grant them. Without
that, a write fails with an `AuthError` (exit 3) that says which scope it needs and that
`auth login --allow-writes` asks for it, phrased as a fact rather than advice (0001's rule about
agents and escalation).

**Use a separate app registration for writing.** The 0001 spike found, and the 2026-10-22 run
confirmed, that a token carries every scope ever consented to its client ID, whatever was asked for.
Once anyone signs in with `--allow-writes` against a registration, every later token from it can
post. A read-only registration for the agent's everyday server, and a second one, selected with
`TEAMS_CLIENT_ID`, for the server or shell that may write, is the boundary that binds; the rest are
guardrails.

| Layer                                         | Stops                                        | Boundary? |
| --------------------------------------------- | -------------------------------------------- | --------- |
| `--dry-run` / `dryRun`                        | sending before a person has looked           | no        |
| `TEAMS_READ_ONLY`                             | the wrong context, a forgotten env file      | no        |
| MCP read-only default, `--allow-writes`       | write tools being in the agent's loop at all | no        |
| A registration consented only for read scopes | Graph accepts no post from it, whatever runs | **yes**   |

### Sent once

Graph messages have no idempotency key, and a duplicate post is visible to everyone in the channel.
The transport therefore marks writes `mutating` (`GraphClient.send`) and retries only what proves
Graph did not act:

| Failure on a write | Retried?                                                             | Message ends with                                          |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 429                | yes                                                                  | —                                                          |
| connection refused | yes                                                                  | —                                                          |
| 401                | once, after a token refresh (Graph rejected the token before acting) | —                                                          |
| 5xx                | no                                                                   | `The message may have been posted; check before retrying.` |
| connection dropped | no                                                                   | the same                                                   |
| timeout            | no                                                                   | the same                                                   |

This errs towards a false alarm. In a long-running MCP server, a pooled connection that went stale
while idle fails with `ECONNRESET` or `UND_ERR_SOCKET` before Graph receives anything, and the post
still reports "may have been posted". The transport cannot tell that from a connection dropped after
the request landed, so both are treated as possibly sent; the cost is a check that finds nothing.

Reads, including search's read-only POST, keep 0001's policy. The MCP instructions tell the agent
that "may have been posted" means check, not retry. This is simply-atlassian's 0017 rule, ported.

### Attribution

A message posted this way appears exactly as if the signed-in person typed it: their name and photo,
and a notification to everyone the post would normally notify. Nothing marks it as sent by a tool.
The write-safety guide says so in its first sentence, and every write tool's description says so.

## Alternatives considered

- **`--confirm` on every write.** Posts can be deleted by their author, and a confirm that is always
  required trains callers to always pass it (simply-atlassian 0004's reasoning). `--dry-run` is the
  preview. Whether a channel post with a large audience deserves `--confirm` is an open question.
- **Broader scopes (`ChannelMessage.ReadWrite`, `Chat.ReadWrite`).** They would also let the tool
  edit and delete, which nothing here does. The narrowest scope per command was chosen.
- **Markdown input.** Graph takes text or HTML only. Converting Markdown is possible later, as
  simply-atlassian 0013 did for Confluence.
- **Mentions placed by the caller (`{@0}` markers).** More control, more syntax for an agent to get
  wrong. Mentions at the start cover the common case: "@Ada, deployed".
- **Beta endpoints.** v1.0 covers all three calls; 0001's rule stands.

## Implementation plan

1. Core: `WRITE_SCOPES` (`token.ts`); `mutating` and the retry rule (`http.ts`); `GraphClient.send`;
   `message-body.ts` (`escapeHtml`, `textToHtml`, `buildMessageBody`); in `operations.ts`
   `resolveMentions`, `planChannelPost`, `planChannelReply`, `planChatSend`, `sendPlanned`, and
   `SCOPES.users|channelSend|chatSend`; `signIn(…, { writes })` and `missingWriteScopes`.
2. CLI: `shared/write-output.ts` (the shared flags and `deliver`); `channel post`, `message reply`,
   `chat send` with `isWrite = true`; `auth login --allow-writes`; a "Can post" status line.
3. MCP: three `kind: 'write'` tools with `dryRun`; the instructions' paragraph on writes.
4. Docs: this record, the write-safety guide, the scopes in the credentials and app-registration
   guides, the READMEs.

## Testing

- **core/http**: a write is sent once on a 502, a dropped connection, and a timeout, each saying it
  may have been posted; retried on a 429; sent after one refresh on a 401; a read POST still retries
  a 5xx.
- **core/message-body**: escaping, line breaks, HTML as given, mentions with `mentions[]`, empty and
  doubled bodies refused.
- **core/operations**: the request shape and scope for each command, the stored message returned in
  the read shape, reply-to-a-reply goes to the root, a dry run sends nothing, a mention resolved
  with `User.ReadBasic.All` and an unknown one refused, an empty message refused before any request.
- **core/auth-status**: write scopes requested only with `writes`, and reported apart.
- **CLI** (nock): the posted body, `--dry-run`, `TEAMS_READ_ONLY` exits 2 before any request, a 403
  exits 3 naming the scope and `--allow-writes`, a 502 is not retried, reply and chat send.
- **MCP**: the three write tools appear only with `--allow-writes`, take `dryRun`, are refused under
  `TEAMS_READ_ONLY`, and return what the CLI returns.
- **Manual, 2026-10-22**: on a Business trial tenant, with a token holding `ChannelMessage.Send`,
  three messages (a post, a reply, and a post with a mention and bold text) were sent through Graph
  directly and read back with `channel messages --replies`, `message view` and `message search`;
  the rendering and refs matched. The commands themselves are verified by the tests above and by a
  live run before release.

## Open questions

- **`--confirm` for large audiences.** Should a channel post to a channel with many members require
  it? It would need a member count per post.
- **Editing and deleting.** Out of scope; they need `ChannelMessage.ReadWrite`/`Chat.ReadWrite` and
  `--confirm` for deletes, as simply-atlassian 0004 treats irreversible changes.
- **Attachments and images.** Graph's hosted contents and file references are their own design.
