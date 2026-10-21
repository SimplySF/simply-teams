---
title: Credentials
description: How the Simply Teams CLI signs in through the operating system, which Entra app registration and scopes it needs, and how flags, environment variables, and an env file take precedence.
---

Simply Teams holds no password and no token of its own. It asks the operating system's identity
broker (Web Account Manager on Windows, the Enterprise SSO plug-in on macOS) for Microsoft Graph
tokens, as the account the machine is already signed in with. On an Entra ID–joined machine that
normally needs no input at all. The broker keeps the session, bound to the device, so nothing is
written to disk.

What it does need is the **app registration** to sign in for: Graph only issues tokens to a
registered app.

## Settings

Settings come from environment variables, from flags, or from a `.env` file named with
`-e/--env-file`. Explicit flags beat the environment, which beats the file's contents.

| Variable               | Flag          | Meaning                                                                           | Default                                      |
| ---------------------- | ------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `TEAMS_CLIENT_ID`      | `--client-id` | Application (client) ID of the Entra app registration. A GUID.                    | required, unless `TEAMS_ACCESS_TOKEN` is set |
| `TEAMS_TENANT_ID`      | `--tenant`    | Tenant GUID or verified domain.                                                   | `organizations`: the account's home tenant   |
| `TEAMS_CLOUD`          | `--cloud`     | `global`, `usgov-high`, or `dod`. GCC Moderate tenants use `global`.              | `global`                                     |
| `TEAMS_ACCESS_TOKEN`   | none          | A Microsoft Graph access token used as-is, skipping the broker.                   | unset                                        |
| `TEAMS_NO_INTERACTIVE` | none          | Never show a sign-in window, even for `auth login`.                               | unset                                        |
| `TEAMS_READ_ONLY`      | none          | Refuse every write. Nothing writes yet; this is honoured for when something does. | unset                                        |

Only these variables are read from an `--env-file`; anything else in it, such as
`NODE_TLS_REJECT_UNAUTHORIZED`, is ignored. A variable already set in the environment wins over the
file, and an unreadable file is an error rather than silently skipped.

## Registering the app

A tenant needs one Entra app registration for simply-teams, created once. [Registering the app](app-registration.md)
has the exact steps: the broker redirect URI, the six delegated permissions with their IDs, and
the admin-consent link. Then set `TEAMS_CLIENT_ID` to the registration's application (client) ID.

### Scopes

All the scopes are delegated, so the CLI can never see more than you can already see in Teams.

| Scope                     | Used for                                             | Admin consent |
| ------------------------- | ---------------------------------------------------- | ------------- |
| `User.Read`               | `auth status`: who you are                           | no            |
| `User.ReadBasic.All`      | Resolving senders to names                           | no            |
| `Chat.Read`               | Reading 1:1, group, and meeting chats                | no            |
| `Team.ReadBasic.All`      | Listing the teams you have joined                    | no            |
| `Channel.ReadBasic.All`   | Listing channels                                     | no            |
| `ChannelMessage.Read.All` | Reading channel messages, and **any** message search | **yes**       |

`ChannelMessage.Read.All` gates search entirely. Graph's `chatMessage` search requires both
`Chat.Read` and `ChannelMessage.Read.All`, and without the second it refuses chat search too. Only a
tenant administrator can consent to it. Until one does, `auth status` lists it under
**Missing scopes**.

Each command asks the broker only for the scopes it needs, so a missing admin-only scope breaks the
commands that use it and nothing else. `auth status` asks for `User.Read` alone, so it still works,
and still says what is missing, before an administrator has acted.

| Command                                             | Asks for                               | Works without admin consent? |
| --------------------------------------------------- | -------------------------------------- | ---------------------------- |
| `auth status`                                       | `User.Read`                            | yes                          |
| `chat list`, `chat messages`, `message view` (chat) | `Chat.Read`                            | yes                          |
| `team list`                                         | `Team.ReadBasic.All`                   | yes                          |
| `channel list`                                      | `Channel.ReadBasic.All`                | yes                          |
| `message search`                                    | `Chat.Read`, `ChannelMessage.Read.All` | **no**                       |
| `channel messages`, `message view` (channel)        | `ChannelMessage.Read.All`              | **no**                       |

Until an administrator consents, `chat messages --since 7d` is the way to read a known chat.

The app registration must be consented for these exact scope names. The broker will not substitute
a broader grant: an app consented for `Chat.ReadWrite` but not `Chat.Read` still fails a `Chat.Read`
request with `interaction_required`.

## Signing in

```sh
simply teams auth login
```

`auth login` asks for every scope above at once, so consent happens at this one moment rather than
in the middle of later work. Usually nothing appears. When the broker needs you (first-time
consent, a Conditional Access check), it shows its own account picker. On a joined machine that is
one click, never a password.

```sh
simply teams auth status
```

`auth status` signs in silently, asks Graph who the token belongs to, and reports:

- the account, tenant, and cloud;
- whether the broker or `TEAMS_ACCESS_TOKEN` is in use;
- when the token expires;
- which scopes are missing.

Asking Graph is the point. A token can be issued and still be refused, for example by Conditional
Access, and a status that only looked at the token would call that healthy. The token itself is
never printed.

**Only `auth login` may show a sign-in window.** Every other command, and the MCP server always,
signs in silently or fails with exit code 3 and a message saying to run `simply teams auth login`.
A window never appears in the middle of something a script or an agent started. The first sign-in
in a new process takes a moment. After that, tokens come back from the broker in tens of
milliseconds.

## Machines without a broker

If no broker is available (Linux, or a machine that is not joined or registered), the CLI fails with
a configuration error rather than falling back to a browser sign-in. Set `TEAMS_ACCESS_TOKEN` to a
Microsoft Graph access token instead:

```sh
export TEAMS_ACCESS_TOKEN=eyJ0eXAi…
simply teams auth status
```

- **No flag, on purpose.** There is deliberately no flag for it, so a token never sits in shell
  history or a process listing.
- **No client ID needed.** With a token set, `TEAMS_CLIENT_ID` is not required.
- **It expires.** Graph tokens last about an hour, and an expired one is refused up front with an
  error naming the variable.
- **It is never printed.** It is redacted from every error message and response body.

## Certificates

Certificate verification is always on. On a network that inspects TLS with an internal or agency CA,
trust that CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` rather than disabling verification.
