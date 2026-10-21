# Contributing

Thanks for your interest in contributing to Simply Teams! This document covers the repo structure, how to get set up, and how to submit changes.

1. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).
2. Create a new issue before starting significant work so we can keep track of what you're trying to add or fix, offer suggestions, and avoid duplicate effort.
3. Fork this repository.
4. [Set up your environment](#setup) and make sure you can build and test the affected package(s) locally.
5. Create a topic branch in your fork.
6. For a new command, a user-visible flag/output/error change, or a new shared module, write a design document in [`docs/design/`](docs/design/README.md) and get it agreed on before you start implementing.
7. Make your change, following the [commit message format](#commit-messages) below.
8. Write tests for your change. No pull request will be accepted without tests covering the change.
9. Open a pull request against `main`. We'll review your code, suggest any needed changes, and merge it in.

## Repository Structure

This repository is a Lerna monorepo holding the CLI package, the two library packages it is built on,
and an MCP server package. Every package has its own `CONTRIBUTING.md` covering what is specific to
it — read this file first, then that one.

| Package                                                     | Description                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`@simplysf/simply-teams`](packages/simply-teams)           | The `simply teams` CLI                                                               |
| [`@simplysf/simply-teams-core`](packages/simply-teams-core) | Configuration, the Microsoft Graph client, and shared logic; no runtime dependencies |
| [`@simplysf/simply-teams-auth`](packages/simply-teams-auth) | Sign-in through the operating system's identity broker; the only package with MSAL   |
| [`@simplysf/simply-teams-mcp`](packages/simply-teams-mcp)   | MCP server exposing Teams to AI agents, one tool per CLI command                     |

Tooling:

- **Package manager:** pnpm workspaces
- **Task orchestration:** Lerna v10 (independent versioning) + Wireit (per-package build caching)
- **Language:** TypeScript (ESM)
- **CLI framework:** [oclif](https://oclif.io/)
- **Node:** ^22.13.0 || ^24.0.0 || ^26.0.0 (required by Lerna 10; the published CLI itself only requires >=22.0.0)

## Setup

This repo pins its pnpm version via the `packageManager` field in `package.json`. Use [Corepack](https://nodejs.org/api/corepack.html) (bundled with Node.js) to install that exact version rather than installing pnpm globally:

```sh
corepack enable
git clone git@github.com:SimplySF/simply-teams.git
cd simply-teams
corepack install   # installs the pnpm version pinned in package.json
pnpm install
pnpm run build
pnpm test
```

`corepack enable` only needs to be run once per machine. After that, Corepack transparently uses whatever version of pnpm is pinned in `package.json`, so every contributor and CI job runs the same version.

`pnpm install` at the root installs and links every workspace package and sets up git hooks automatically via husky.

pnpm runs no dependency install scripts unless `pnpm-workspace.yaml` allows them under `allowBuilds`.
One is allowed on purpose: `keytar`. `@azure/msal-node-extensions` imports it eagerly from its ESM
entry point, even though this repo never uses its credential-storage features, so without the
prebuilt `keytar.node` binary that its install script downloads, signing in fails with "Cannot find
module '../build/Release/keytar.node'". The broker binaries themselves ship prebuilt inside
`@azure/msal-node-runtime`, so `@azure/msal-node-extensions`' own (no-op) script stays disallowed.

To try sign-in for real you need an Entra app registration; see the
[credentials guide](packages/simply-teams/docs/guides/credentials.md).

To try your changes without installing the package globally, run its local dev binary from inside the package directory:

```sh
cd packages/simply-teams
./bin/dev.js --help
```

or link it so you can run `simply` from anywhere:

```sh
cd packages/simply-teams
npm link
```

## Common Commands

Run from the repo root to target all packages:

```sh
pnpm run build       # lerna run build (compile + lint)
pnpm run compile     # lerna run compile
pnpm run lint        # lerna run lint
pnpm run test        # lerna run test
pnpm run test:only   # lerna run test:only
pnpm run format      # lerna run format
pnpm run reset       # clear node_modules, the lockfile, and all wireit/TS/ESLint caches
pnpm run reset:install  # same as reset, then reinstall dependencies
```

Run inside a single package directory to target just that package:

```sh
cd packages/simply-teams
pnpm run build
pnpm test
```

## Adding a Dependency

To add a dependency to a specific package:

```sh
pnpm add <package> --filter @simplysf/simply-teams
```

To add a root-level devDependency (e.g., a shared build tool):

```sh
pnpm add -w -D <package>
```

## Documentation

The published documentation lives at
[simplysf.github.io/simply-cli/teams](https://simplysf.github.io/simply-cli/teams/), built by
[SimplySF/simply-cli](https://github.com/SimplySF/simply-cli) from the **published packages** — this
repo no longer builds a site of its own.

That means the guides are part of the packages:

| Location                          | Published as       |
| --------------------------------- | ------------------ |
| `packages/simply-teams/docs/`     | guides for the CLI |
| `packages/simply-teams-mcp/docs/` | the MCP guide      |

Both directories are in their package's `files`, so they travel with a release. The combined site
downloads each published tarball and renders what it finds — so **a guide change reaches the site
when the package is released**, not when it is merged. That is deliberate: the site then describes
what people actually have installed rather than what is on `main`.

The command reference is generated from each package's `oclif.manifest.json`, which `prepack`
produces. Nothing there is hand-written; fix a command's summary, description, or examples in
`src/` and the reference follows on the next release.

Keep a guide in sync with the behaviour it describes when you change that behaviour — a guide that
no longer matches `--help` is worse than no guide.

The `redirect/` directory keeps the old `simplysf.github.io/simply-teams/` URLs working by forwarding
each one to its equivalent under the combined site. It is deployed by `.github/workflows/docs.yml`.

## Commit Messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint on commit). Once release automation is wired up, Lerna will use your commit types to decide which packages get versioned and how their `CHANGELOG.md` is generated — so it's worth getting right now even though nothing consumes it yet.

```text
feat: add support for X
fix: correct handling of Y
docs: update README
chore: bump a dependency
```

If your change only affects one package, scope the commit to it, e.g. `feat(simply-teams): add teams message search command`.

## Pull Requests

- Keep pull requests focused on a single change where possible.
- If the change has a design document in [`docs/design/`](docs/design/README.md), update it to match what actually shipped, including its `Status` line and its row in the index. A design doc that quietly disagrees with the code is worse than none.
- Make sure `pnpm run build` and `pnpm test` pass before opening the PR. CI runs both across every package; the pre-push hook runs the same checks but scoped to packages changed since the last release tag (see [Git Hooks](#git-hooks)), so a passing push doesn't guarantee a passing PR if your branch touches a root-level config file (e.g. `tsconfig.json`, `eslint.config.mjs`) that no single package's directory reflects.
- Aim for high test coverage on new code.
- Update the relevant package's README/command docs if you changed a command's flags or behavior: run `pnpm run readme` in `packages/simply-teams` and commit the result. Nothing local enforces this, and CI does not catch a stale README.
- If the change affects credentials, write safety, the `--json`/exit-code contract, or the MCP server, update the matching guide under `packages/*/docs/guides/` (see [Documentation](#documentation)).
- If you added a CLI command, add the matching MCP tool. `packages/simply-teams-mcp/test/tools.test.ts` cross-checks the catalogue against `command-snapshot.json` in both directions, so this one CI does catch.
- `command-snapshot.json` (used to flag accidental breaking changes to commands/flags) regenerates automatically as part of each package's `pnpm run build` — just commit whatever changes. CI re-verifies with `git diff --exit-code` after `pnpm run build`, so a stale, uncommitted snapshot fails the build.

## Versioning and Publishing

Versioning uses Lerna's independent mode — each package has its own version and can release separately. `release.yml` versions from conventional commits on a push to `main` and publishes whatever is committed to git but still missing from npm.

## CI

| Workflow      | Trigger                                                   | What it does                                                                       |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `test.yml`    | Push to non-main branches                                 | Runs `pnpm run build` + `pnpm test` on Linux (lts/_, lts/-1) and Windows (lts/_)   |
| `release.yml` | Push to `main` or `prerelease/**`, or manual dispatch     | Builds, tests, versions from conventional commits with Lerna, and publishes to npm |
| `docs.yml`    | Push to `main` touching `redirect/**`, or manual dispatch | Deploys the redirect that forwards old documentation URLs to the combined site     |

## Git Hooks

| Hook         | Command                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — runs `prettier --write` on staged files                                       |
| `commit-msg` | `commitlint` — enforces conventional commit format                                            |
| `pre-push`   | `lerna run build --since --include-dependents && lerna run test --since --include-dependents` |

`pre-push` only builds/tests packages changed since the last release tag (plus their transitive
dependents) to keep the hook fast locally — CI (`test.yml`) always runs `pnpm run build` + `pnpm test`
across every package, so nothing changed here reduces what actually gates a merge.

Hooks are installed automatically on `pnpm install` via the `prepare: husky` script.

## Reporting Issues

Please report bugs or request features by [opening an issue](https://github.com/SimplySF/simply-teams/issues) rather than submitting a PR without prior discussion for anything non-trivial.
