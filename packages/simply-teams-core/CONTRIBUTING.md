# Contributing to @simplysf/simply-teams-core

Configuration, the Microsoft Graph client, and shared logic for working with Microsoft Teams. This package is part of the [`simply-teams`](https://github.com/SimplySF/simply-teams) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-teams/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

## This is a library, not a CLI

There are no commands, no `command-snapshot.json`, and no `pnpm run readme` here. The public surface
is whatever [`src/index.ts`](src/index.ts) re-exports; anything not exported from there is internal
and can change freely. Adding to the public surface means adding an export to `src/index.ts` **and**
mentioning it in [`README.md`](README.md). `test/index.test.ts` asserts the exported-key list; update
it deliberately when the surface changes, so an accidental removal fails loudly instead of shipping
quietly.

Both `@simplysf/simply-teams` (the CLI) and `@simplysf/simply-teams-mcp` (the MCP server) are built
on this package, and it is also meant to be installed and imported directly by scripts and tooling
that want Teams access without shelling out to the CLI.

## The no-terminal rule

Nothing here may touch a terminal or a process: no oclif, no child processes, no `process.argv`,
nothing written to stdout or stderr. `process.env` is read only through an injectable `env` parameter
that defaults to it, so a caller can pass its own. The repo's lint config enforces the import half of
this — `@oclif/*` and `node:child_process` are refused in this package — but the rest is convention,
and it is the convention that makes the same behavior usable from a command, a server, and a script.

## No sign-in here

This package never acquires a token itself. It depends on the `TokenProvider` interface in
[`src/token.ts`](src/token.ts), and `@simplysf/simply-teams-auth` implements it against the
operating system's broker. Keep it that way: importing MSAL here would add a native binary to every
consumer and every unit test, and break this package's zero-runtime-dependency rule. Tests pass a
small fake provider instead.

When you add a Graph call, set `scopes` on it to exactly what that endpoint needs. Each call asks the
provider for its own scopes (incremental consent), so a scope that lacks admin consent breaks only
the calls that need it.

## Testing against HTTP

[`src/testing.ts`](src/testing.ts) is a real local HTTP server, exported publicly as
`@simplysf/simply-teams-core/testing`, and it is what every layer of this repo tests against —
including the CLI and MCP packages. Prefer it to mocking `fetch`: it exercises the actual request
this code builds, headers and query string included, which is where most of the bugs in a REST client
live. Code that must reach `https://graph.microsoft.com` itself (a `GraphClient` takes a `baseUrl`
override, so this is rare) can use `nock`, which intercepts native `fetch`.

## Design documents

Changes to configuration, token handling, HTTP behavior, or pagination conventions are covered by
[0001](../../docs/design/0001-teams-client-core-and-auth.md). Update it when you change what it describes.
