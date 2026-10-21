# Contributing to @simplysf/simply-teams-auth

Sign-in to Microsoft Graph through the operating system's identity broker, for `simply-teams`. This
package is part of the [`simply-teams`](https://github.com/SimplySF/simply-teams) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-teams/blob/main/CONTRIBUTING.md).**
It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and
the pull request process, all of which apply here. This file covers only what is specific to this
package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run lint
```

## This is a library, and the only home of MSAL

There are no commands here. The public surface is whatever [`src/index.ts`](src/index.ts) exports.
The same no-terminal rule as `@simplysf/simply-teams-core` applies: no oclif, no child processes, no
`process.argv`, nothing written to stdout or stderr. The lint config enforces the import half of
that rule for both packages.

Nowhere else in the repo may import `@azure/msal-node` or `@azure/msal-node-extensions`. Core
depends only on the `TokenProvider` interface, and the CLI and MCP server get a provider from
`createTokenProvider`.

## Rules that are easy to break

- **Keep MSAL lazy.** It is imported inside the default `createClient` factory, never at module top
  level. That keeps the native broker binary out of unit tests and out of any process that uses
  `TEAMS_ACCESS_TOKEN`.
- **Never let MSAL reach a browser.** Check `isBrokerAvailable` before building the client, and pass
  `refuseBrowser` as `openBrowser` on every call. msal-node falls back to a loopback web server and
  a browser tab when the broker fails to start, which is not the seamless sign-in this tool promises
  and is impossible from the MCP server.
- **Respect `config.interactive`.** Only the broker's own prompt may follow a failed silent attempt,
  and only when interaction is allowed. The MCP server always passes `false`.
- **Never store anything.** The broker keeps the refresh token. Do not add MSAL's persistence
  plugins. If a broker-less platform ever needs a disk cache, that needs a design doc first.
- **Keep `brokerWasLoaded()` accurate.** The CLI uses it to end the process: the broker's native
  logging callback keeps Node's event loop alive permanently.

## Testing

`test/broker.test.ts` passes a scripted fake through the `createClient` option, so no test loads
the native binary or calls the real broker. To check real behavior on a machine with a broker, set
`TEAMS_CLIENT_ID` and run `./bin/dev.js teams auth status` from `packages/simply-teams`.

## Design documents

Any change to how sign-in works needs a design doc first. The current design is
[0001](../../docs/design/0001-teams-client-core-and-auth.md).
