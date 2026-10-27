# Simply Teams

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Teams is a command-line interface built by [SimplySF](https://github.com/SimplySF) for
reading and posting in Microsoft Teams, and an MCP server that gives an AI agent the same capabilities. The goal is
to let an agent working in a codebase find the context behind a change: the chat where a requirement
was clarified, the thread where an approach was agreed.

Sign-in is seamless. It uses the account the operating system is already signed in with, through
its identity broker (Web Account Manager on Windows), so on an Entra ID–joined machine there is
normally no prompt at all, and this tool stores no credentials of its own.

**Status:** early and unreleased. The CLI signs in, searches messages, and reads chats, channels
and threads; it can also post in a channel, reply in a thread, and send in a chat. The MCP server
exposes the same commands, with the writes only under `--allow-writes`. See
[docs/design](docs/design/README.md).

This repo is a Lerna/pnpm monorepo, following the same conventions as SimplySF's
[`simply-gitlab`](https://github.com/SimplySF/simply-gitlab) and
[`simply-atlassian`](https://github.com/SimplySF/simply-atlassian) repos.

## Packages

| Package                                                     | Description                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@simplysf/simply-teams`](packages/simply-teams)           | The `simply teams` CLI                                                                |
| [`@simplysf/simply-teams-core`](packages/simply-teams-core) | Configuration, the Microsoft Graph client, and shared logic; no dependencies, no MSAL |
| [`@simplysf/simply-teams-auth`](packages/simply-teams-auth) | Sign-in through the operating system's identity broker (MSAL with WAM)                |
| [`@simplysf/simply-teams-mcp`](packages/simply-teams-mcp)   | MCP server exposing Teams to AI agents, one tool per CLI command                      |

## Installation

All packages need Node.js 22 or later.

**The CLI**, for a person at a terminal or a script:

```sh
npm install -g @simplysf/simply-cli
simply teams --help
```

**The MCP server**, for an AI agent in Claude Desktop, Claude Code, Cursor, VS Code, or any other
MCP client:

```sh
npm install -g @simplysf/simply-teams-mcp
simply-teams-mcp --help
```

## Connecting

Graph only issues tokens to a registered app, so the one required setting is the application
(client) ID of an Entra app registration. Everything else has a default.

| Setting   | Variable          | Flag          | Default                                             |
| --------- | ----------------- | ------------- | --------------------------------------------------- |
| Client ID | `TEAMS_CLIENT_ID` | `--client-id` | required                                            |
| Tenant    | `TEAMS_TENANT_ID` | `--tenant`    | the home tenant of the account you are signed in as |
| Cloud     | `TEAMS_CLOUD`     | `--cloud`     | `global` (GCC Moderate uses `global` too)           |

```sh
export TEAMS_CLIENT_ID=00000000-0000-0000-0000-000000000000

simply teams auth login    # once: lets the broker ask for consent if it needs to
simply teams auth status   # who you are, and which scopes are still missing
```

How to register the app, which scopes it needs (one of them needs an administrator's consent), and
the `TEAMS_ACCESS_TOKEN` escape hatch are in the
[credentials guide](packages/simply-teams/docs/guides/credentials.md).

## Safety

- **Read-only unless you opt in.** Posting needs the send scopes, which only
  `teams auth login --allow-writes` asks for. The MCP server registers the write tools only with
  `--allow-writes`, `TEAMS_READ_ONLY=1` refuses every write, and `--dry-run` shows a post before it is
  sent. A post appears exactly as if you had typed it. See the
  [write-safety guide](packages/simply-teams/docs/guides/write-safety.md).
- **No stored credentials.** The broker keeps the session, bound to the device. A
  `TEAMS_ACCESS_TOKEN`, if you supply one, is read from the environment only (there is no flag), so
  it never sits in shell history, and it is redacted from every error message and response body.
- **The MCP server never opens a sign-in window.** If the broker needs you, the tool says to run
  `simply teams auth login` in a terminal.
- **What an agent sees is cleaned.** A message that holds a secret (a key, a token, a connection
  string with a password) is withheld whole; email addresses, phone numbers and other personal data
  are replaced with placeholders such as `[EMAIL-1]`, which the server puts back if the agent uses
  them in a reply or a search. On by default in the MCP server, `--clean` in the CLI
  ([design 0005](docs/design/0005-cleaning-before-the-agent.md)).
- **Teams messages are untrusted text.** Anyone in a chat writes them. Control characters are
  stripped before anything is printed, and the MCP server tells the agent to treat message content as
  data, never as instructions.

## Documentation

- [Command reference](packages/simply-teams/README.md): every command, flag, and example
- [Registering the app](packages/simply-teams/docs/guides/app-registration.md): the one-time Entra
  setup a tenant needs before anyone can sign in
- [Write safety](packages/simply-teams/docs/guides/write-safety.md): what posting does, the layers in front of it, and why a failed post is not retried
- [Credentials guide](packages/simply-teams/docs/guides/credentials.md): settings, scopes, and how
  sign-in resolves
- [MCP server](packages/simply-teams-mcp/README.md): the tool catalogue and client setup
- [Design documents](docs/design/README.md): why things are the way they are
- [Contributing](CONTRIBUTING.md): setup, checks, and the pull-request checklist

## License

Apache-2.0. See [LICENSE.txt](LICENSE.txt).
