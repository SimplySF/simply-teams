# @simplysf/simply-teams-core

Configuration, the Microsoft Graph client, and the shared logic that
[`@simplysf/simply-teams`](../simply-teams) (the CLI) and
[`@simplysf/simply-teams-mcp`](../simply-teams-mcp) (the MCP server) are both built on.

Everything a command does between parsing its input and rendering its result lives here, so the CLI
and the MCP server cannot disagree about what a rule means. Nothing in this package touches a
terminal or a process: no oclif, no child processes, no `process.argv`, nothing written to stdout or
stderr. `process.env` is read only through an injectable `env` parameter.

Nor does it sign in. Tokens arrive through the `TokenProvider` interface, which
[`@simplysf/simply-teams-auth`](../simply-teams-auth) implements against the operating system's
identity broker. That split keeps this package free of runtime dependencies and of MSAL's native
binary.

```sh
npm install @simplysf/simply-teams-core
```

## Usage

```ts
import { GraphClient, resolveTeamsConfig, staticTokenProvider } from '@simplysf/simply-teams-core';

// Reads TEAMS_CLIENT_ID, TEAMS_TENANT_ID, TEAMS_CLOUD, and TEAMS_ACCESS_TOKEN, and throws a
// ConfigError naming whatever is missing or malformed.
const config = resolveTeamsConfig();

// Any TokenProvider works. For seamless sign-in, use createTokenProvider(config) from
// @simplysf/simply-teams-auth instead of a fixed token.
const graph = new GraphClient(config, staticTokenProvider(process.env.TEAMS_ACCESS_TOKEN ?? ''));

const me = await graph.me();

// Lists follow @odata.nextLink up to your limit and tell you whether they got everything. Each call
// names the scopes it needs; the token provider asks for exactly those.
const { items, complete } = await graph.list('/me/chats', { scopes: ['Chat.Read'], limit: 50 });
if (!complete) console.warn(`showing the first ${items.length}`);
```

## What is in here

**Configuration**: `resolveTeamsConfig` (flags over environment; validates the client ID, tenant,
and cloud), `CLOUDS` (login and Graph hosts for `global`, `usgov-high`, and `dod`), the `*_ENV`
variable names, and `loadEnvFile`/`parseEnvFile` for an allowlisted `.env` file.

**Tokens**: the `TokenProvider` interface; `staticTokenProvider` and `describeStaticToken` for a
supplied token (an expired one is refused up front); `READ_SCOPES`, `WRITE_SCOPES`, `BASE_SCOPES`, `graphScopes`,
`shortScope`, and `missingScopes`, which allows for broader grants but deliberately accepts nothing
in place of `ChannelMessage.Read.All`.

**Transport**: `HttpTransport`. It fetches a token per request and answers a 401 with exactly one
forced refresh. It retries 429 and 5xx with a capped `Retry-After`, except that a call marked
`mutating` is retried only on a 429 or a refused connection, so a message is never posted twice. It
applies a 30 s deadline that
covers the response body. It refuses to send the token to any origin but the configured Graph host,
and it never follows a redirect.

**The client**: `GraphClient`, with `me()`, `get()`, `post()` (a POST that reads), `send()` (a POST
that writes, sent once), `pages()` and `list()`; every list returns `{ items, pages, complete }`.

**Errors**: `ConfigError` (exit 2), `AuthError` (3), `NetworkError` (1), and `HttpError` (1), all
extending `CliError`. Graph's `{ error: { code, message } }` is surfaced as the message.

**Safety**:

- `assertWritesAllowed` and `isReadOnly` for `TEAMS_READ_ONLY`.
- `redactSecrets` and `sanitiseDeep` keep a supplied token out of any message or response body.
- `stripControl` and `stripControlOneLine` clean text that other people wrote.

**Operations**: `authStatus` and `signIn`, which confirm the account with Graph and report the
missing read and write scopes, never the token; the reads (`searchMessages`, `viewMessage`,
`listChats`, `listChatMessages`, `listTeams`, `listChannels`, `listChannelMessages`); and the writes
(design 0004): `planChannelPost`, `planChannelReply` and `planChatSend` build the exact request, and
`sendPlanned` posts it and returns the stored message. `buildMessageBody` escapes text and links
mentions.

**Message context** (design 0006): `gatherMessageContext` searches, groups hits into threads, reads
each around its hits and returns them in relevance order within a character budget.

**Cleaning** (design 0005): `secretsIn`, `TeamsGuard` (placeholders for personal data, kept stable and
restorable), `cleanResult` (withholds items holding a secret, placeholders the rest, leaves
identifiers alone, and reports what it did) and `restoreInput`; `DETECTOR_TYPES` for the corpus
test.

**Rendering**: `formatTable`, `formatKeyValue`.

**Testing**: `@simplysf/simply-teams-core/testing` exports `startTestServer` and `respondJson`, a
tiny local HTTP server that records every request.

## Stability

Every export from `src/index.ts` is semver-covered: adding one is a minor or patch change, removing
or renaming one is breaking. `test/index.test.ts` pins the list, so a removal fails a test rather
than shipping quietly in a patch.

## Documentation

- [Teams client core and sign-in design](../../docs/design/0001-teams-client-core-and-auth.md)
- [Contributing](./CONTRIBUTING.md)

## License

Apache-2.0.
