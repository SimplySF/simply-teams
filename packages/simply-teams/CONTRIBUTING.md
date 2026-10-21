# Contributing to @simplysf/simply-teams

The `simply teams` command-line interface. This package is part of the [`simply-teams`](https://github.com/SimplySF/simply-teams) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-teams/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run build       # command-snapshot + compile + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm run readme      # regenerate the command reference in README.md
TEAMS_CLIENT_ID=<guid> ./bin/dev.js teams auth status   # run without compiling
```

`bin/dev.js` runs the TypeScript directly through ts-node; `bin/run.js` runs the compiled `lib/`.

## Where the logic goes

Not here. A command parses flags, calls into `@simplysf/simply-teams-core`, renders the result, and
returns the value oclif prints under `--json`. Anything between input and request — validating an
scope, building a request, deciding what a partial result means — belongs in core, because the MCP
server needs the same rule and a second implementation of it will drift.

The rule to check a new command against: could the MCP tool for this command call the same functions?
If not, something that should be in core is in the command.

## Adding a command

1. Write the design document first — see [docs/design/README.md](../../docs/design/README.md).
2. Put the behavior in `@simplysf/simply-teams-core`, with its tests.
3. Add the command under `src/commands/teams/`, extending `TeamsCommand`. Set
   `public static override isWrite = true` if it changes data; the read-only guard is enforced
   centrally in `init()`, so nothing else is needed for it. Leave `interactiveSignIn` false:
   only `teams auth login` may open a sign-in window. Build clients with `this.graph()` and
   `this.tokens()`, so the command shares one token provider and the base class can end the
   process after the broker is loaded (see `finally()` in `src/shared/base-command.ts`).
4. Add the matching tool to `packages/simply-teams-mcp/src/tools.ts`, with its `command` naming this
   one. `test/tools.test.ts` over there cross-checks both directions against
   `command-snapshot.json`, so skipping this fails CI.
5. Run `pnpm run build` and commit the regenerated `command-snapshot.json`.
6. Run `pnpm run readme` and commit the regenerated `README.md`. Nothing enforces this — CI catches a
   stale snapshot, but not a stale README.

## Command copy

Summaries, descriptions, and examples live inline as static class properties. There is no
`messages/*.md` convention here.

Write the description for someone who does not already know Microsoft Graph. The details worth
spending a line on are the ones where Graph does something surprising: that message search needs an
admin-consented scope even for chats, or that a command never prompts and says to run
`teams auth login` instead. A description that restates the summary is worse
than none, because it costs a reader time to find that out.

## Printing

Use `this.logSafe()`, not `this.log()`, for anything Graph returned. Messages, chat topics, and
display names are written by other people, and `logSafe` strips the control characters that would otherwise let one of them overwrite what the
terminal already showed.

`this.log()` is fine for text this CLI wrote itself, such as headings and counts.

## Output shape

Return the value you want under `--json` from `run()`; oclif prints it verbatim. Human-readable
output goes through `formatTable` or `formatKeyValue` from core.

A list command that was cut short by `--limit` must say so — `reportList()` does this — so a partial
answer is never mistaken for the whole one.

## Testing

Command tests sign in with `TEAMS_ACCESS_TOKEN` set to an unsigned test JWT and intercept
`https://graph.microsoft.com` with `nock`, so they never touch the broker or the network. See
`test/commands/teams/auth.test.ts`.
