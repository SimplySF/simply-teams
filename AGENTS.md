# AGENTS.md

## Documentation map

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull-request checklist.
Read [docs/design/README.md](docs/design/README.md) before changing a user-visible command,
shared module, authentication, or API behavior; it defines when a design document is required and
indexes the topic records.

Use the smallest relevant topic document rather than loading the whole directory:

- [Teams client core, ambient sign-in, and package layout](docs/design/0001-teams-client-core-and-auth.md):
  why there are four packages, how a token is acquired (the OS broker, silently, with
  `TEAMS_ACCESS_TOKEN` as the escape hatch), scopes and admin consent, the Graph transport, why the
  MCP server never prompts, and the alternatives rejected for sign-in.
- [Signing in before admin consent](docs/design/0003-consent-without-admin.md): why `auth login`
  asks for the user-grantable scopes interactively and the admin-only one silently, and the
  admin-consent link it prints.
- [Read commands](docs/design/0002-read-commands.md): message search, view with context,
  chats, teams and channels; the normalized message shape; Teams links as references.
- [Writes](docs/design/0004-writes.md): channel post, thread reply and chat send; the send scopes
  kept out of `READ_SCOPES`; why writes are sent once and never retried after a 5xx; dry runs.
- [Cleaning](docs/design/0005-cleaning-before-the-agent.md): the guard ported from
  simply-confluence-explorer; a message holding a secret is withheld whole, personal data becomes
  `[EMAIL-1]` placeholders that are restored when the agent writes; on by default in the MCP server,
  `--clean` in the CLI.
- [Message context](docs/design/0006-message-context.md): `message context` searches, groups the
  hits into threads, and reads each around its hits within a character budget, so "where was this
  discussed?" is one call.
- [Search before admin consent](docs/design/0007-search-before-admin-consent.md): when Graph
  refuses search for want of `ChannelMessage.Read.All`, the user's recent chats are read on the
  client instead (`Chat.Read` only), the result says so in `note`, and `--chats-only` asks for it.

The package [README](packages/simply-teams/README.md) is the generated user-facing command
reference. Update command metadata first, then regenerate it as described in `CONTRIBUTING.md`.

The published documentation is built by [simply-cli](https://github.com/SimplySF/simply-cli) from
the **published packages**, not from this repo. The guides live in `packages/*/docs/guides/` and are
listed in each package's `files`, so they travel with a release; the command reference is generated
from `oclif.manifest.json`. A guide change therefore reaches the site when the package is released,
not when it merges — which is deliberate, so the site describes what people have installed. Never
hand-write a reference page. A guide that no longer matches `--help` is worse than no guide.

## Working conventions

- **Implement functionality in `@simplysf/simply-teams-core` first, then expose it through both
  `simply-teams` (the CLI) and `simply-teams-mcp`.** The core package holds the behavior; the
  other two are thin surfaces over it. Putting logic in a command means the MCP server cannot reach
  it without a second implementation, and two implementations of the same rule drift.

  Both surfaces are closed allowlists, so exposing is a real step rather than something that happens
  for free: a CLI command declares its `flags`, and an MCP tool declares its `inputSchema`. A
  capability that lives in core and reaches only one of them is the failure worth checking for.

  Anything touching a terminal, a process, `process.argv`, stdout or stderr stays out of core.

- **`@simplysf/simply-teams-auth` is a library too, and the only place MSAL lives.** Core depends on
  the `TokenProvider` interface alone, which keeps it free of runtime dependencies and of the native
  broker binary; the lint config holds both packages to the same no-oclif, no-child-process rule.
  MSAL is imported lazily inside the auth package, so a caller using `TEAMS_ACCESS_TOKEN`, and every
  unit test, never loads the native binary. Tests fake the MSAL client through `createClient`.

- **Once the broker is loaded, Node never exits on its own.** It registers a native logging callback
  that nothing can unregister. `TeamsCommand.finally()` in
  `packages/simply-teams/src/shared/base-command.ts` handles this with an unref'd exit timer, guarded
  by `brokerWasLoaded()`. A new command inherits it; anything that runs a command outside that base
  class has to deal with it itself. The MCP server is long-lived, so it is unaffected.

- **Only `teams auth login` may open a sign-in window** (`static interactiveSignIn = true`). Every
  other command, and the MCP server always, fails with exit code 3 and a pointer to that command
  instead, so a window never appears in the middle of something a script or an agent started.

- **Each Graph call names the scopes it needs** (`scopes` on the call). The broker is asked for
  exactly those (incremental consent), so a scope that lacks admin consent breaks only the commands
  that need it. `auth status` asks for `User.Read` alone for that reason.

- **The MCP server cleans every result before an agent sees it** (`invokeTool`, design 0005). The
  guard is one `TeamsGuard` per server; its placeholder map must never be returned, logged or
  written. New result shapes need their free-text fields named in `guard-results.ts`'s `FREE_TEXT`,
  and their identifiers in `IDENTIFIERS`, or they are cleaned as plain strings.

- **Anything Graph returned is untrusted text.** Teams messages, display names, and chat topics are
  written by anyone in the chat or the tenant. Print them through `logSafe`, never `this.log`. Error
  messages that interpolate a response body use `stripControlOneLine`, so a newline in a body cannot
  forge an extra stderr line. Never print a token: status objects carry metadata only, and tests
  assert the token is absent.

- A new command, user-visible flag/output/error change, new shared module, or **any change to how
  sign-in works** needs a design document in `docs/design/` **before** implementation, following the
  process in [docs/design/README.md](docs/design/README.md). After landing, correct the doc to match
  what shipped and update its `Status` line and index row.

- Before calling a command or flag change finished, work through the "Pull Requests" checklist in
  `CONTRIBUTING.md`. Nothing local enforces two of its steps, so they are the ones most often
  skipped: run `pnpm run readme` in `packages/simply-teams` and commit the regenerated README, and
  run `pnpm run build` so `command-snapshot.json` regenerates and commit it. CI catches a stale
  snapshot but not a stale README.

- Every CLI command needs a matching MCP tool whose `command` names it.
  `packages/simply-teams-mcp/test/tools.test.ts` cross-checks the catalogue against
  `command-snapshot.json` in both directions, so adding a command without a tool fails CI. A command
  deliberately left without a tool (today, `teams auth login`) is listed there with the design doc
  that says why.

- The MCP client-config logic in `simply-teams-mcp/src/mcpClients` is kept identical to the copies in
  simply-gitlab and simply-atlassian: change all of them together.

- Command copy (summaries, descriptions, examples) lives inline as static class properties on the
  command classes. There is no `messages/*.md` convention here.
