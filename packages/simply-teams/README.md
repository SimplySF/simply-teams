# @simplysf/simply-teams

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-teams?label=@simplysf/simply-teams)](https://npmjs.com/@simplysf/simply-teams) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-teams/main/LICENSE.txt)

Command-line interface for reading Microsoft Teams, built by [SimplySF](https://github.com/SimplySF).

It signs in as the account your operating system is already signed in with, through its identity
broker (Web Account Manager on Windows), so on an Entra ID–joined machine there is normally no
prompt and nothing is stored. Output is human-readable by default and JSON with `--json`, so it is
usable both at a terminal and by a script or agent. See [Commands](#commands) below for the full
reference.

This release covers sign-in (`teams auth login`, `teams auth status`). Message search and reading
chats, channels, and threads come next.

The same capabilities are available to AI agents through
[`@simplysf/simply-teams-mcp`](https://github.com/SimplySF/simply-teams/tree/main/packages/simply-teams-mcp).

## Documentation

Guides and the full command reference: **https://simplysf.github.io/simply-cli/teams/**

The guides also ship inside this package, under [`docs/`](docs).

## Install

`@simplysf/simply-teams` is a plugin of the `simply` CLI, not a command of its own. Install the host;
this plugin installs itself the first time you run one of its commands.

```sh
npm install -g @simplysf/simply-cli

simply teams --help
```

To install it ahead of time (in CI, a container image, or offline):

```sh
simply plugins install @simplysf/simply-teams
```

## Issues

Please report any issues at https://github.com/SimplySF/simply-teams/issues

## Contributing

This package is part of the [`@simplysf/simply-teams`](https://github.com/SimplySF/simply-teams) monorepo. See the repo's [CONTRIBUTING.md](https://github.com/SimplySF/simply-teams/blob/main/CONTRIBUTING.md) for the repo structure, how to set up and build the project, our commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-teams/blob/main/CODE_OF_CONDUCT.md).

## Signing in

Graph only issues tokens to a registered app, so the one required setting is the application
(client) ID of an Entra app registration. Settings come from environment variables, from flags, or
from a `.env` file named with `-e/--env-file`. Only simply-teams settings are read from that file;
anything else in it is ignored.

```
TEAMS_CLIENT_ID=00000000-0000-0000-0000-000000000000   # required
TEAMS_TENANT_ID=contoso.com                            # optional: defaults to your home tenant
TEAMS_CLOUD=global                                     # optional: global, usgov-high, or dod
```

Explicit flags beat the environment, which beats the file's contents.

```sh
simply teams auth login    # once: lets the broker ask for consent if it needs to
simply teams auth status   # who you are, and which scopes are still missing
```

`auth login` is the only command that may show a sign-in window. Every other command signs in
silently. If the broker needs you, the command fails with exit code 3 and tells you to run
`auth login`.

A tenant needs an app registration first: see [Registering the app](docs/guides/app-registration.md).
Message search needs `ChannelMessage.Read.All`, which only a tenant administrator can consent to;
`auth login` still succeeds without it and prints the link an administrator can use. The
[credentials guide](docs/guides/credentials.md) covers registering the app, the full scope list,
and `TEAMS_ACCESS_TOKEN` for machines without a broker.

## Reading untrusted text

Teams messages, chat topics, and display names are written by other people. Control characters are
stripped from them before anything is printed, so an escape sequence cannot make your terminal show
something other than what Graph returned. Tokens are never printed. A `TEAMS_ACCESS_TOKEN` is
redacted from every error message and response body.

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Success                                                    |
| 1    | Request or network failure                                 |
| 2    | Configuration or usage error                               |
| 3    | Sign-in needed, or Graph refused the token or a permission |

Under `--json`, a failure writes a single JSON object to **stderr**
(`{"error":{name, message, exitCode, status?, body?}}`) and nothing to stdout. Exit codes are
identical with and without `--json`.

# Commands

<!-- commands -->

- [`simply teams auth login`](#simply-teams-auth-login)
- [`simply teams auth status`](#simply-teams-auth-status)
- [`simply teams channel list TEAM`](#simply-teams-channel-list-team)
- [`simply teams channel messages CHANNEL`](#simply-teams-channel-messages-channel)
- [`simply teams chat list`](#simply-teams-chat-list)
- [`simply teams chat messages CHAT`](#simply-teams-chat-messages-chat)
- [`simply teams message search [QUERY]`](#simply-teams-message-search-query)
- [`simply teams message view REF`](#simply-teams-message-view-ref)
- [`simply teams team list`](#simply-teams-team-list)

## `simply teams auth login`

Sign in through the operating system, confirming once if asked.

```
USAGE
  $ simply teams auth login [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod]

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Sign in through the operating system, confirming once if asked.

  Signs in as the account the operating system is signed in with, through its identity broker (Web Account Manager on
  Windows). Usually nothing appears at all. When the broker needs you, for first-time consent or a Conditional Access
  check, it shows its own account picker; on a machine joined to Entra ID that is one click, never a password.

  Nothing is stored by this CLI: the broker keeps the session, so every later command and the MCP server sign in
  silently. Run this again only when one of them says to.

  ChannelMessage.Read.All, which message search and the channel commands need, can only be granted by a tenant
  administrator. Login does not wait for it: the chat, team, and channel list commands work straight away, and login
  prints the link an administrator can use to grant it.

EXAMPLES
  $ simply teams auth login

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/auth/login.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/auth/login.js)_

## `simply teams auth status`

Show who you are signed in as, and which scopes are missing.

```
USAGE
  $ simply teams auth status [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod]

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show who you are signed in as, and which scopes are missing.

  Signs in silently as the account the operating system is signed in with, then asks Microsoft Graph who that is, so a
  token that is issued but refused (by Conditional Access, say) is reported as a failure rather than as healthy. Never
  opens a sign-in window: if one is needed, it fails with exit code 3 and says to run "simply teams auth login".

  The token itself is never printed.

EXAMPLES
  Check the session

    $ simply teams auth status

  Check it from a script

    $ simply teams auth status --json

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/auth/status.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/auth/status.js)_

## `simply teams channel list TEAM`

List the channels in a team.

```
USAGE
  $ simply teams channel list TEAM [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod]

ARGUMENTS
  TEAM  A team name, ref, or link.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List the channels in a team.

  Takes a team's display name, its ref from "teams team list", or a team link. Pass a channel's ref to "teams channel
  messages" to read it.

EXAMPLES
  $ simply teams channel list "Platform Engineering"

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/channel/list.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/channel/list.js)_

## `simply teams channel messages CHANNEL`

Read the recent posts in a channel, oldest first.

```
USAGE
  $ simply teams channel messages CHANNEL [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [--since <value>] [--replies] [--include-events] [--limit <value>]

ARGUMENTS
  CHANNEL  A channel link, a channel ref, or "Team/Channel" by name.

FLAGS
  --include-events  Also show system events.
  --limit=<value>   [default: 25] Maximum number of posts to return across all pages.
  --replies         Also fetch each post's replies.
  --since=<value>   Only posts created on or after this date: YYYY-MM-DD, or relative like 7d.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Read the recent posts in a channel, oldest first.

  Takes a channel link, a channel ref from "teams channel list", or "Team name/Channel name". Lists the posts that start
  threads; --replies also fetches each post's replies, one request per post, indented beneath it.

  Needs ChannelMessage.Read.All, which only a tenant administrator can consent to.

EXAMPLES
  This week in a channel, with replies

    $ simply teams channel messages "Platform/General" --since 7d --replies

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/channel/messages.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/channel/messages.js)_

## `simply teams chat list`

List your chats, most recently active first.

```
USAGE
  $ simply teams chat list [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [--limit <value>]

FLAGS
  --limit=<value>  [default: 20] Maximum number of chats to return across all pages.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List your chats, most recently active first.

  Shows 1:1, group, and meeting chats with their last message. A chat with no topic is labelled by whoever sent its last
  message. Pass a chat's ref to "teams chat messages" to read it.

EXAMPLES
  $ simply teams chat list --limit 10

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/chat/list.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/chat/list.js)_

## `simply teams chat messages CHAT`

Read the recent messages in a chat, oldest first.

```
USAGE
  $ simply teams chat messages CHAT [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [--since <value>] [--include-events] [--limit <value>]

ARGUMENTS
  CHAT  A Teams chat link, or a chat ref.

FLAGS
  --include-events  Also show system events (calls, membership changes).
  --limit=<value>   [default: 50] Maximum number of messages to return across all pages.
  --since=<value>   Stop at messages older than this: YYYY-MM-DD, or relative like 7d.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Read the recent messages in a chat, oldest first.

  Takes a chat link or a chat ref from "teams chat list". Reads back from the newest message until --limit messages are
  collected or --since is passed, then prints them as a transcript. System events such as calls starting and members
  joining are left out unless --include-events is passed.

  This needs only Chat.Read, so it works before an administrator has consented to message search.

EXAMPLES
  What was said in a chat this week

    $ simply teams chat messages <chat-ref> --since 7d

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/chat/messages.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/chat/messages.js)_

## `simply teams message search [QUERY]`

Search the chat and channel messages you can see.

```
USAGE
  $ simply teams message search [QUERY] [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [--from <value>] [--since <value>] [--until <value>] [--mentions-me] [--limit <value>]

ARGUMENTS
  [QUERY]  Words or KQL to search for. Optional when a filter flag is given.

FLAGS
  --from=<value>   Only messages from this person: a name or email address.
  --limit=<value>  [default: 25] Maximum number of results to return across all pages.
  --mentions-me    Only messages that @mention you.
  --since=<value>  Only messages sent on or after this date: YYYY-MM-DD, or relative like 7d.
  --until=<value>  Only messages sent on or before this date.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Search the chat and channel messages you can see.

  Runs a Microsoft Search query over every Teams chat and channel message you have access to. The query is KQL: plain
  words match anywhere in a message, its sender, or its attachments, and the flags add the documented filters. Results
  come in relevance order; Graph cannot sort them.

  Each result is a snippet, not the whole message. Pass its ref to "teams message view" for the full text and, with
  --context, the conversation around it.

  Needs ChannelMessage.Read.All, which only a tenant administrator can consent to. Graph refuses message search entirely
  without it, even for chats.

EXAMPLES
  Find where something was discussed

    $ simply teams message search "release freeze"

  Narrow to one sender in the last two weeks

    $ simply teams message search deploy --from ada@contoso.com --since 2w

  Messages that mention you

    $ simply teams message search --mentions-me --since 7d

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/message/search.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/message/search.js)_

## `simply teams message view REF`

Show one message in full, optionally with the conversation around it.

```
USAGE
  $ simply teams message view REF [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [-c <value>]

ARGUMENTS
  REF  A Teams message link, or a message ref from a result.

FLAGS
  -c, --context=<value>  How many messages to show on each side of this one.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show one message in full, optionally with the conversation around it.

  Takes a Teams link ("Copy link" on any message) or a ref from another command's output. With --context, also shows the
  conversation: for a channel message, its root post and the replies nearest it; for a chat message, the messages either
  side. A chat has no "messages around this one" lookup, so context walks back through at most the 500 most recent
  messages.

EXAMPLES
  Read a message someone linked you to

    $ simply teams message view "https://teams.microsoft.com/l/message/19%3A…/1729512345678?…"

  See five messages either side of a search hit

    $ simply teams message view <ref> --context 5

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/message/view.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/message/view.js)_

## `simply teams team list`

List the teams you are a member of.

```
USAGE
  $ simply teams team list [--json] [-e <value>] [--client-id <value>] [--tenant <value>] [--cloud
    global|usgov-high|dod] [--limit <value>]

FLAGS
  --limit=<value>  [default: 100] Maximum number of teams to return across all pages.

CONNECTION FLAGS
  -e, --env-file=<value>   Path to a .env file holding connection settings.
      --client-id=<value>  [env: TEAMS_CLIENT_ID] Application (client) ID of the Entra app registration to sign in for.
      --cloud=<option>     [env: TEAMS_CLOUD] Microsoft cloud to use. GCC Moderate tenants use global.
                           <options: global|usgov-high|dod>
      --tenant=<value>     [env: TEAMS_TENANT_ID] Tenant GUID or domain. Defaults to the home tenant of the account you
                           are signed in with.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List the teams you are a member of.

  A team can be named by its display name or its ref in "teams channel list" and "teams channel messages".

EXAMPLES
  $ simply teams team list

FLAG DESCRIPTIONS
  -e, --env-file=<value>  Path to a .env file holding connection settings.

    Loaded before anything else. Variables already present in the environment win, so the file never overrides an
    explicit export, and only simply-teams settings are read from it. A path that cannot be read is an error.
```

_See code: [lib/commands/teams/team/list.js](https://github.com/SimplySF/simply-teams/blob/@simplysf/simply-teams@0.0.0/packages/simply-teams/lib/commands/teams/team/list.js)_
<!-- commandsstop -->
