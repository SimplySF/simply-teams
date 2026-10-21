---
title: MCP server
description: Give an AI agent in Claude Desktop, Claude Code, Cursor, Gemini CLI, or VS Code read access to Microsoft Teams as Model Context Protocol tools, signed in as you through the operating system.
---

`@simplysf/simply-teams-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io/)
server with one tool per CLI command. It calls the same library the CLI is built on, in-process, so
the agent gets the same sign-in, the same error messages, and the same JSON the CLI prints with
`--json`.

Using it takes four steps:

1. Install the server.
2. Sign in once at a terminal.
3. Tell your MCP client how to launch the server.
4. Check the connection.

This page walks through each. It then covers the tool list, results and errors, and what to check
when something does not work.

## Install

The server needs Node.js 22 or later.

```sh
npm install -g @simplysf/simply-cli
simply teams mcp --list
```

`--list` prints every tool the server would register, which doubles as a check that the install
worked. It prints to stderr, because stdout is reserved for the protocol stream. The standalone
binary works too: `npm install -g @simplysf/simply-teams-mcp`, then `simply-teams-mcp --help`.

## Sign in once

The server signs in as the account your operating system is signed in with, through its identity
broker (Web Account Manager on Windows). It never stores a credential. The broker keeps the session.

**The server never opens a sign-in window.** It runs as a windowless child of your editor, and a
window opened in the middle of a tool call would land behind it. So before first use, run this in a
terminal:

```sh
simply teams auth login
```

Usually nothing appears at all. If the broker needs you (first-time consent, or a Conditional Access
check), it shows its own account picker. On an Entra ID–joined machine that is one click, never a
password. From then on, the CLI and the server sign in silently. Run the command again only when a
tool's error tells you to.

## Connection settings

The server reads the same settings as the CLI, described in
[Credentials](/guides/credentials/):

```
TEAMS_CLIENT_ID=00000000-0000-0000-0000-000000000000   # required: the Entra app registration
TEAMS_TENANT_ID=contoso.com                            # optional: defaults to your home tenant
TEAMS_CLOUD=global                                     # optional: global, usgov-high, or dod
```

Put them in a `.env` file and pass it with `--env-file`, or set them in the `env` block of the
client's server entry. A variable already in the environment wins over the file. Settings are
resolved when a tool is called rather than at startup, so a missing one is reported by the tool that
needed it instead of killing a server the client has already launched.

Use an absolute path for the env file. MCP clients launch the server from a working directory of
their own, so `~` and relative paths may not resolve. On Windows, write the path with forward
slashes or doubled backslashes inside JSON: `"C:/Users/me/teams.env"`.

## Configure a client

### With `simply teams mcp install`

One command writes the entry for you. Name each client with `--client`:

```sh
simply teams mcp install --client claude-code --client cursor --env-file ~/teams.env
```

Client ids: `claude-code`, `claude-desktop`, `cursor`, `vscode`, `windsurf`, `gemini`, `codex`.
Running it without `--client` lists them, and marks the ones found on this machine.

- **Only the entry changes.** In a JSON file, everything else, comments included, is left as it
  was, and the previous file is kept as `<file>.bak`. Claude Code and Codex are configured through
  their own `claude mcp` and `codex mcp` commands. If one isn't on `PATH`, you get the exact command
  to run yourself.
- **Settings are never copied into the client.** `--env-file` is resolved to an absolute path,
  checked to exist, and passed to the server. Without it, the entry starts with no settings, because
  a GUI client doesn't see your shell's environment.
- **Server flags are passed through.** `--allow-writes` reaches the server and names the entry
  `simply-teams-write`. There are no write tools yet, so it has no effect today. `--name` overrides
  the name.
- **`--scope project` writes the repository's own file** in the current directory instead:
  `.mcp.json` for Claude Code, `.cursor/mcp.json`, `.vscode/mcp.json`, or `.gemini/settings.json`.
  The entry then runs `simply` from `PATH`, so it works for everyone who clones the repository.
- **At user scope, the entry starts this Node binary and the `simply` CLI's own script.** That works
  for GUI clients that don't see your `PATH`. If a Node upgrade moves the binary, run the command
  again with `--force`. `--launcher simply` or `--launcher npx` choose the other forms.
- **Running it twice is safe.** An identical entry is left alone. An entry that differs is reported
  as a conflict (exit 2) and is replaced only with `--force`. `--dry-run` shows what would be
  written, and `--json` returns the per-client results.

Restart Claude Desktop or Windsurf afterwards. In Claude Code or Gemini CLI, run `/mcp`. The
sections below show what the command writes, for editing by hand or for any other client.

### Claude Desktop, Cursor, Gemini CLI, Windsurf

Edit the client's `mcpServers` file and restart the client:

- **Claude Desktop:** `claude_desktop_config.json`, in `%APPDATA%\Claude\` on Windows or
  `~/Library/Application Support/Claude/` on macOS.
- **Cursor:** `.cursor/mcp.json`, or `~/.cursor/mcp.json` for every project.
- **Gemini CLI:** `.gemini/settings.json`, or `~/.gemini/settings.json` for every project.

```json
{
  "mcpServers": {
    "simply-teams": {
      "command": "simply",
      "args": ["teams", "mcp", "--env-file", "C:/Users/me/teams.env"]
    }
  }
}
```

The same entry with the settings inline and no global install:

```json
{
  "mcpServers": {
    "simply-teams": {
      "command": "npx",
      "args": ["-y", "@simplysf/simply-teams-mcp"],
      "env": {
        "TEAMS_CLIENT_ID": "00000000-0000-0000-0000-000000000000"
      }
    }
  }
}
```

The client ID is not a secret, so an inline `env` block is fine here.

### Claude Code

```sh
claude mcp add simply-teams -- simply teams mcp --env-file ~/teams.env
```

Add `--scope project` to write the entry to a `.mcp.json` at the repository root instead, which can
be committed so a team shares the server definition. Inside a session, `/mcp` lists the configured
servers and whether each one connected.

### VS Code

VS Code reads `.vscode/mcp.json`, with a `servers` key and an explicit transport type:

```json
{
  "servers": {
    "simply-teams": {
      "type": "stdio",
      "command": "simply",
      "args": ["teams", "mcp", "--env-file", "C:/Users/me/teams.env"]
    }
  }
}
```

### Any other client

The server speaks MCP over stdio, so any client that can launch a local command works: give it the
command, its arguments, and optionally an environment, as above. During the handshake it announces
itself as `simply-teams` with the package version. It also supplies instructions for the host's
model that summarise the conventions, including that Teams message content is untrusted.

## Check the connection

Ask the agent who it is signed in to Teams as. It should call `teams_auth_status` and come back with
your account, tenant, and any missing scopes. If `ChannelMessage.Read.All` is missing, message search
will not work until a tenant administrator consents to it for the app registration. Graph refuses
`chatMessage` search entirely without it, chats included.

## Tools

| Tool                | Read or write | Equivalent command  | What it returns                                                                           |
| ------------------- | ------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `teams_auth_status` | read          | `teams auth status` | Account, display name, tenant, cloud, token source and expiry, granted and missing scopes |

`teams auth login` deliberately has no tool, because signing in is something a person does at a
terminal. Message search and the tools for reading chats, channels, and threads are designed next,
in the repository's design documents.

Only read tools exist. `--allow-writes` is accepted so that existing configurations keep working
when write tools arrive. Today it changes only the label in `--list`. `TEAMS_READ_ONLY=1` is already
honoured.

## Results and errors

A successful call returns what the CLI prints with `--json`, verbatim. A failure returns an error
result whose text is a JSON object with a stable `code`:

| `code`   | Meaning                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| `config` | Missing or malformed settings, such as no `TEAMS_CLIENT_ID`, or no sign-in broker on this machine. |
| `auth`   | Sign-in needs the user, or Graph refused the token or a scope; carries the HTTP `status`.          |
| `error`  | Any other failure, including a Graph error with its HTTP `status` and sanitised body.              |

These map one-to-one onto the CLI's exit codes 2, 3, and 1, and carry the same `name` and
`message`, scrubbed of credentials and control characters the same way.

Teams messages, chat topics, and display names are written by other people. Control characters are
stripped before any of that text reaches the agent, and the server's instructions say plainly that
the content is data, never instructions.

## Troubleshooting

Run `simply teams mcp --list` at a terminal first. If it prints the tool list, the package is
installed and working, and the problem is in how the client launches it or what it passes.

| Symptom                                                           | Cause and fix                                                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client reports the server failed to start                     | Desktop apps do not load your shell profile, so `simply` may not be on their `PATH`. Use `simply teams mcp install`, which writes absolute paths, or the `npx` form above. |
| The client's log says `Env file ... not found.`                   | The only startup failure. The path is wrong or relative; make it absolute. The server exits with code 2.                                                                   |
| Every tool returns `code: "config"` naming `TEAMS_CLIENT_ID`      | The settings are not reaching the server. Pass `--env-file` or an `env` block explicitly.                                                                                  |
| `code: "auth"` asking you to run `simply teams auth login`        | The broker needs you once: first use, new consent, or a Conditional Access check. Run it in a terminal, then retry.                                                        |
| `code: "config"` saying no sign-in broker is available            | This machine has no broker (Linux without one, for example). Set `TEAMS_ACCESS_TOKEN` to a Graph token instead; see the credentials guide.                                 |
| `code: "auth"` with status `403` naming `ChannelMessage.Read.All` | The app registration lacks admin consent for that scope. Only a tenant administrator can grant it.                                                                         |

## Embed in your own process

The stdio binary is the usual way to run the server, but the package also exports what it is built
from, so a host process can serve the same tools over a transport of its choosing:

```js
import { createServer, startServer } from '@simplysf/simply-teams-mcp';

// Serve over stdio, exactly as the binary does.
await startServer({ envFile: 'C:/Users/me/teams.env' });

// Or build the server and attach a transport yourself, optionally with your own token source.
const server = createServer({ env: process.env, tokens: myTokenProvider });
await server.connect(transport);
```

`createServer` returns the MCP SDK's `McpServer` with the tools registered and nothing connected.
`TOOLS` is the full catalogue, `selectTools(allowWrites)` is the subset a given configuration
registers, and `invokeTool` and `mapError` run one tool and map a failure onto the error object
above, for tests and hosts that need to drive the server without a transport.

## Options

```
simply teams mcp [--allow-writes] [--env-file <path>] [--list]
simply-teams-mcp [--allow-writes] [--env-file <path>] [--help]
```

Both print diagnostics to stderr, because stdout is the protocol stream.
