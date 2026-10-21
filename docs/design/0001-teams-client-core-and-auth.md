# 0001 — Teams client core, ambient sign-in, and package layout

**Status:** In progress (scaffold, core, auth, `teams auth login|status`, and the MCP server
skeleton are implemented and unreleased; see [Spike results](#spike-results-2026-10-21))
**Package:** new repo `simply-teams` — `packages/simply-teams-core`, `packages/simply-teams-auth`,
`packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-21

## Problem

During development, much of the context behind a change lives in Microsoft Teams. That includes
the chat where a requirement was clarified, the channel thread where an approach was agreed,
and the message with the error a tester pasted. An agent working in the codebase can reach
GitLab, Jira and Confluence through `simply-gitlab` and `simply-atlassian`, but it has no route
into Teams. The developer copies and pastes by hand, and context that nobody remembered to paste
gets lost.

The sibling CLIs authenticate with long-lived tokens from environment variables. Teams has no
equivalent:

- Microsoft Graph has no personal access token.
- Every Graph call needs an OAuth access token issued to an Entra ID app registration on behalf
  of the signed-in user.
- Tenant Conditional Access policies decide whether that token is issued at all.

Asking developers to run a device-code dance, or to paste a bearer token that expires within an
hour, would make the tool something nobody uses. The bar the user set is that **authentication
is seamless and uses the account the developer is already signed into on the machine**.

## Decision

Build `simply-teams` as a third sibling, cloned from the `simply-gitlab` template. That template
is a better fit than `simply-atlassian`'s multi-product base classes because Teams is a single
product. It is a pnpm, Lerna and Wireit monorepo with ESM TypeScript, vitest, oclif plugins of
the `simply` host CLI, and a stdio MCP server on the same core. The one structural difference is
a **fourth package for authentication**:

| Package                       | Role                                                                                                                                                                                                             | Runtime deps                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `@simplysf/simply-teams-core` | Config, the Graph HTTP transport, errors, redaction, write safety, output, HTML-to-text, and the domain operations. Depends on a `TokenProvider` **interface** and has no knowledge of MSAL.                     | none (template rule)                              |
| `@simplysf/simply-teams-auth` | `createTokenProvider(config)`. It uses MSAL with the **OS identity broker**: WAM (Web Account Manager) on Windows, the Enterprise SSO plug-in on macOS. A static token from the environment is the escape hatch. | `@azure/msal-node`, `@azure/msal-node-extensions` |
| `@simplysf/simply-teams`      | oclif plugin: `simply teams …`                                                                                                                                                                                   | `@oclif/core`, core, auth                         |
| `@simplysf/simply-teams-mcp`  | oclif plugin plus standalone bin: `simply teams mcp`, `simply teams mcp install`                                                                                                                                 | MCP SDK, zod, `@oclif/core`, core, auth, …        |

Tokens come from the operating system's broker. Windows hands out tokens based on the Primary
Refresh Token (PRT) it already holds for the developer's Entra ID sign-in. On an
Entra-joined machine with a PRT, which this development machine has (`dsregcmd /status`:
`AzureAdJoined: YES`, `AzureAdPrt: YES`), sign-in normally needs no prompt. **The tool never
stores a refresh token.** With the broker in use, the refresh token is bound to the device and is
not visible to the app, so there is nothing for `simply-teams` to leak or encrypt.

The first release is **read-only**: search, then read messages, threads, chats and channels. Writes
(posting a message or a reply) get their own design doc and the template's
`--allow-writes`/`TEAMS_READ_ONLY` gating.

## Behavior

### Configuration

The precedence is the template's: flag, then environment, then `--env-file` (allowlisted variables
only).

| Env var                | Meaning                                                                                                                                 | Default                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `TEAMS_CLIENT_ID`      | Entra app registration (public client) that tokens are issued to. See [Open questions](#open-questions). Also `--client-id`.            | none: required unless `TEAMS_ACCESS_TOKEN` is set (exit 2 naming it)       |
| `TEAMS_TENANT_ID`      | Authority tenant: a GUID or a domain                                                                                                    | `organizations`, which the broker resolves to the OS account's home tenant |
| `TEAMS_CLOUD`          | `global` or `usgov-high` / `dod` (sovereign Graph and login endpoints). GCC Moderate uses `global`.                                     | `global`                                                                   |
| `TEAMS_ACCESS_TOKEN`   | A Graph access token used as is, skipping MSAL. This is for CI, for spikes, and for machines with no broker. It is redacted everywhere. | unset                                                                      |
| `TEAMS_NO_INTERACTIVE` | Never open a sign-in window. If a silent sign-in fails, return an `AuthError`.                                                          | unset (the MCP server always behaves this way, see below)                  |
| `TEAMS_READ_ONLY`      | Template write guard, for when writes exist                                                                                             | unset                                                                      |

### Token acquisition

`TokenProvider.getToken(scopes)` resolves in this order. The first step that succeeds wins.

| Step | Source                                                                                                                                                                                      | Interactive? | When it applies                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `TEAMS_ACCESS_TOKEN`                                                                                                                                                                        | no           | Set. Expiry is checked from the `exp` claim, and an expired token is a `ConfigError` naming the variable.                                                                                       |
| 2    | MSAL `acquireTokenInteractive({ prompt: 'none' })` through `NativeBrokerPlugin`, naming no account: the plugin maps that to the broker's `SignInSilently`, which signs in as the OS account | no           | Windows or macOS with a broker and a signed-in work account. This is the normal path. (`acquireTokenSilent` is not usable here: it requires an account object, and there is none on first use.) |
| 3    | MSAL `acquireTokenInteractive` with no prompt value, through the broker (WAM signs in silently if it can, else shows its account picker; no password with a PRT)                            | yes, once    | `teams auth login` only, when step 2 returns `interaction_required` (first use, new consent, CA step-up).                                                                                       |
| —    | Otherwise                                                                                                                                                                                   | —            | `AuthError` (exit 3) naming `simply teams auth login` as the fix.                                                                                                                               |

Within a process, access tokens are cached in memory, keyed by the requested scope set, until five
minutes before expiry. Across processes the broker supplies them, so every invocation, and every
MCP tool call, is a fast silent call.

Two broker behaviours shaped the implementation:

- **msal-node silently falls back to a browser sign-in** (a loopback server plus a browser tab)
  when the broker fails to start. That is neither seamless nor possible from the MCP server, so
  `BrokerTokenProvider` checks `NativeBrokerPlugin.isBrokerAvailable` first and fails with a
  `ConfigError` naming `TEAMS_ACCESS_TOKEN`. As a second guard, every MSAL request carries an
  `openBrowser` callback that throws.
- **Once loaded, the broker keeps Node alive forever.** Constructing a `PublicClientApplication`
  with the broker registers a native logging callback, and there is no way to unregister it.
  `brokerWasLoaded()` reports whether that has happened. The CLI's base command then arms an
  **unref'd** 500 ms `process.exit()` timer in `finally()`, which fires only when nothing but the
  broker is holding the event loop open. The MCP server is long-lived, so this doesn't affect it.
  MSAL is imported lazily, on the first token request, so a run using `TEAMS_ACCESS_TOKEN` (and
  every unit test) never loads the native binary.

**The MCP server never prompts.** It runs as a windowless stdio child of the agent host. MSAL's
discovery of a parent window handle for a CLI is documented as best-effort, and a sign-in window
appearing behind an IDE in the middle of a tool call is a bad experience. When step 2 needs
interaction, the tool result is `code: "auth"` with the message _"Run `simply teams auth login`
once in a terminal, then retry."_ The developer does that once per machine, plus again whenever
consent changes, and silent sign-in works from then on.

### Scopes

All scopes are delegated, so results are limited to what the user can already see in Teams. The
Graph search API enforces the same access control as a direct `GET`.

| Scope                     | Used for                                           | Admin consent |
| ------------------------- | -------------------------------------------------- | ------------- |
| `User.Read`               | `whoami`, tenant and user ID                       | no            |
| `User.ReadBasic.All`      | Resolving sender IDs to names and `--from` filters | no            |
| `Chat.Read`               | Searching and reading 1:1, group and meeting chats | no            |
| `Team.ReadBasic.All`      | Listing joined teams                               | no            |
| `Channel.ReadBasic.All`   | Listing channels                                   | no            |
| `ChannelMessage.Read.All` | Searching and reading channel messages             | **yes**       |

**Each call asks only for the scopes it uses** (incremental consent): `TokenRequest.scopes`, which
`JsonCall.scopes` passes through. `auth status` asks only for `User.Read`, which any user can
consent to. That way status still works, and can report what is missing, in exactly the situation
it is most needed: before an admin has consented to the rest. The broker's token lists every scope
the user has consented to, whichever were requested, so `missingScopes` is computed from that.
`auth login` requests the full read set in one go, so consent happens at one moment rather than
in the middle of an agent's task.

**There is no chat-only fallback for search.** The spike showed Graph's `chatMessage` search
requires `Chat.Read` (or `Chat.ReadWrite`) **and** `ChannelMessage.Read.All`, with a 403 naming
both, even for a query that would only match chats. Without admin consent, search is unavailable,
and a chat-only search would have to be built from `/me/chats` plus `/chats/{id}/messages` with
client-side filtering (0002 decides whether that is worth it). `missingScopes` accepts no stand-in
for `ChannelMessage.Read.All`: the spike token held `Group.Read.All` and search still refused it.
Meeting transcripts (`OnlineMeetingTranscript.Read.All`, which needs admin
consent) and shared files are out of scope here and get their own doc.

### Graph client

The core's `HttpTransport` is the template's: native `fetch`, a 30 s timeout over the full
exchange, and retries on 429/5xx that honour `Retry-After`. Graph throttles aggressively, which
makes this matter. The bearer token comes from `TokenProvider` per request rather than once per
client, so a long-lived MCP server picks up refreshed tokens. A 401 triggers one forced token
refresh before it surfaces as an `AuthError`. That refresh does not use up a retry attempt. A 403
is an `AuthError` straight away, quoting Graph's `error.code: error.message`, which names the
permission it wanted. The base is `https://graph.microsoft.com/v1.0`, or the sovereign host for
`TEAMS_CLOUD`. Beta endpoints are not used without a doc saying why.

The bearer token only ever goes to the configured Graph origin:

- An absolute path (Graph's `@odata.nextLink`) on any other origin is refused before sending.
- Redirects are not followed (`redirect: 'error'`), because the `Authorization` header would
  travel with them.

Query arrays are comma-joined, which is how OData's `$select` takes its fields.

| Operation             | Graph call                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Message search        | `POST /search/query` with `entityTypes: ["chatMessage"]` and KQL `queryString`, paged by `from`/`size` |
| Message view          | `GET /chats/{id}/messages/{id}` or `/teams/{t}/channels/{c}/messages/{id}`                             |
| Thread view (channel) | The root message plus `…/messages/{id}/replies`                                                        |
| Thread context (chat) | `GET /chats/{id}/messages` around the hit, `--before/--after N`                                        |
| Chat list / messages  | `GET /me/chats`, `GET /chats/{id}/messages`                                                            |
| Team / channel list   | `GET /me/joinedTeams`, `GET /teams/{id}/channels`                                                      |

The rendering and link-parsing modules described below land with the read commands in 0002;
nothing in this doc's scope needs them.

Message bodies are Teams HTML. The core converts them to plain text and light Markdown with a
small dependency-free converter, written the same way as `simply-atlassian`'s page rendering
(0013/0016):

- Mentions become `@Name`.
- Links, code blocks and quotes are kept.
- Cards and attachments are summarised as `[attachment: name]`.
- Control characters are stripped by the template's `text.ts`.

Teams "Copy link" URLs are accepted everywhere an ID is, so a developer can paste a link into
the agent.

### Proposed command and tool surface (detailed in 0002)

| CLI                                   | MCP tool                       |
| ------------------------------------- | ------------------------------ |
| `simply teams auth login`             | — (CLI only)                   |
| `simply teams auth status`            | `teams_auth_status`            |
| `simply teams message search <query>` | `teams_message_search`         |
| `simply teams message view <ref>`     | `teams_message_view`           |
| `simply teams thread view <ref>`      | `teams_thread_view`            |
| `simply teams chat list`              | `teams_chat_list`              |
| `simply teams chat messages <ref>`    | `teams_chat_messages`          |
| `simply teams team list`              | `teams_team_list`              |
| `simply teams channel list`           | `teams_channel_list`           |
| `simply teams channel messages <ref>` | `teams_channel_messages`       |
| `simply teams open <ref>`             | `teams_open` (returns the URL) |

`auth status` reports:

- the account, tenant and cloud;
- whether the broker or `TEAMS_ACCESS_TOKEN` is in use;
- the scopes granted, with any missing ones flagged.

It never prints the token. `message search` adds `--from`, `--since`, `--until`, `--chat` and
`--team/--channel`, which are compiled into KQL, and uses the template's search envelope and
"Showing N of M" truncation line.

### Content safety for agents

Teams messages are written by other people and are **untrusted input** to the agent. The
server's MCP `instructions` say so, and the message tools return message text in a clearly
delimited field rather than inline with tool metadata. The guard is meant to prevent quoting
accidents, not to make any security claim. Results are not cached on disk.

## Alternatives considered

- **Device code flow as the primary sign-in.** It works everywhere and needs no native module,
  but it is the opposite of seamless: a code, a browser, and a re-prompt every time the refresh
  token lapses. Many tenants also block it outright with Conditional Access, because device code
  is a common phishing vector. It is kept only as a possible fallback for broker-less Linux,
  which is an [open question](#open-questions).
- **Reusing the Azure CLI's token (`az account get-access-token`, `AzureCliCredential`).** The
  Azure CLI is not installed on this machine, it is one more login to maintain, and its
  first-party app is not pre-authorised for the `Chat.*` and `ChannelMessage.*` scopes, so it
  cannot read Teams.
- **Lifting tokens from the Teams desktop client, or calling Teams' internal chat service
  APIs.** These would give zero-config access, but they are undocumented, break on Teams
  updates, bypass consent and Conditional Access, and would likely breach the tenant's
  acceptable-use policy. They are rejected outright.
- **Our own token cache on disk (MSAL `PersistenceCachePlugin` with DPAPI or Keychain).**
  It is needed only when there is no broker. With the broker there is nothing to store, and
  storing nothing is better than encrypting something.
- **MSAL inside `simply-teams-core`.** This breaks the template's zero-runtime-dependency rule
  for core and drags a native binary (`@azure/msal-node-runtime`) into every consumer and every
  unit test. A `TokenProvider` interface in core, plus a fake in `core/testing`, keeps core pure,
  and the MSAL code stays in one package.
- **`@azure/identity` with `@azure/identity-broker` (`InteractiveBrowserCredential` plus the
  broker plugin).** It is a thinner API on top of the same MSAL broker, but it adds the Azure SDK
  core dependency stack and hides the silent/interactive split we need to keep the MCP server
  non-interactive. It is worth revisiting if the raw MSAL code turns out larger than expected.
- **The Microsoft Graph JavaScript SDK.** It is the same objection 0001 in `simply-atlassian`
  made to `jira.js`: a large surface for the handful of endpoints we use, and the SDK would own
  retry and auth behaviour. Native `fetch` on the template transport is preferred.

## Implementation plan

0. **Spike first.** Done; see [Spike results](#spike-results-2026-10-21).
1. **Done.** The `simply-gitlab` template is copied into `simply-teams` with `git archive` and
   renamed, with GitLab domain code removed. `simply-teams-auth` is added to the workspace,
   Lerna, Wireit and the library lint rules (no oclif, no `child_process`).
2. **Done.** Core:
   - `config.ts`: env, flags, cloud endpoints.
   - `token.ts`: the `TokenProvider` interface, scope helpers, and static-token parsing.
   - `http.ts`: per-request token, one refresh on 401, same-origin guard.
   - `graph-client.ts`: `me()`, plus `list()` over `@odata.nextLink`.
   - `auth-status.ts`.

   `html-text.ts` and `refs.ts` move to 0002.

3. **Done.** Auth: `broker.ts` (`BrokerTokenProvider`, `brokerWasLoaded`) and `index.ts`
   (`createTokenProvider`).
4. **Done.** CLI: `base-command.ts` (the template's `catch`, exit codes and `--json`, plus the
   broker exit timer and `interactiveSignIn`), `teams auth login`, and `teams auth status`.
5. **Done.** MCP: the template server, a `context.ts` with one non-interactive provider per
   server, `mcpClients/` verbatim, and one tool, `teams_auth_status`. `teams:auth:login` is
   deliberately left unexposed.

### Spike results (2026-10-21)

Run on an Entra-joined Windows 11 machine with a PRT, using the Microsoft Graph Command Line Tools
client ID (open question 1c), `@azure/msal-node` 7.1.0, and `@azure/msal-node-extensions` 5.5.2.

| Question                             | Result                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Silent sign-in as the OS account | **Yes, with no prompt.** About 1.4 s cold, and 1.6 s for a full `teams auth status` CLI run. The first run in a new scope set once took 23 s, which has not recurred. When consent is missing for a requested scope, the result is `interaction_required` (0xCAA2000C), not a prompt. |
| (b) A second process                 | Silent in 17–80 ms: the broker holds the session.                                                                                                                                                                                                                                     |
| (c) `chatMessage` search             | **Needs `ChannelMessage.Read.All` even for chats.** It returned a 403 naming both scopes. One transient 502 was also seen, which the retry policy covers.                                                                                                                             |
| (d) Missing admin consent            | A clear 403 from Graph, and `missingScopes` reports it.                                                                                                                                                                                                                               |

Also found:

- The broker returns **every** scope ever consented to the client ID, whatever was requested. With
  the borrowed first-party app that included `Mail.Send`, `Sites.FullControl.All` and
  `Application.ReadWrite.All`, all of it held in an agent's process. That is a strong argument for
  a dedicated app registration consented only for the read scopes (open question 1).
- `@azure/msal-node-extensions` imports `keytar` eagerly from its ESM entry, even though the broker
  path never uses it. `keytar`'s install script, which downloads a prebuilt binary, must therefore
  run: `pnpm-workspace.yaml` sets `allowBuilds: keytar: true`. `keytar` is archived upstream.
- `@azure/msal-node-runtime` ships prebuilt broker binaries for Windows (x64, arm64, x86), macOS
  (x64, arm64), and Linux (Ubuntu and RHEL, x64).

## Testing

As implemented (`pnpm test` passes across all four packages):

- **core/config**:
  - flag precedence over env;
  - `TEAMS_CLOUD` maps to the right login and Graph hosts, and `gcc` is refused with a pointer
    to `global`;
  - a missing client ID names `TEAMS_CLIENT_ID`, and a non-GUID client ID is refused;
  - the environment can disable interaction but never force it on.
- **core/token**:
  - scopes are qualified per cloud;
  - broader grants cover narrower ones, and nothing stands in for `ChannelMessage.Read.All`;
  - an expired `TEAMS_ACCESS_TOKEN` is a `ConfigError`, and an opaque token passes through.
- **core/http** (local `node:http` server, as in the template):
  - the bearer token is sent, and the scopes a call names reach the provider;
  - a 401 triggers exactly one forced refresh, then succeeds or raises `AuthError`;
  - a 403 is not retried and quotes Graph's message;
  - 503 is retried, and 500 exhausts to `HttpError`;
  - same-origin `nextLink` is followed, another origin is refused without sending, and redirects
    are not followed;
  - multi-line bodies collapse to one line.
- **core/graph-client**:
  - `list` follows `nextLink`, applies the query to the first page only, honours the limit and
    reports `complete`;
  - `authStatus` reports the missing scopes, never includes the token, and asks only for
    `User.Read`.
- **auth**: the MSAL client is faked through `createClient`, so the broker binary never loads in
  unit tests:
  - silent sign-in as the OS account;
  - per-cloud scopes;
  - a cache per scope set with a 5-minute margin, and `forceRefresh`;
  - interactive fallback only when allowed, and otherwise an `AuthError` naming `auth login`;
  - first-line error messages;
  - the browser callback always throws;
  - a static token bypasses the broker;
  - creating a provider does not load the broker.
- **CLI** (nock on `graph.microsoft.com`, with a static token):
  - `auth status --json` returns the status without the token;
  - a 401 exits 3 with one JSON line on stderr;
  - missing configuration exits 2 naming `TEAMS_CLIENT_ID`;
  - only `auth login` may prompt.
- **MCP**:
  - the catalogue is cross-checked against `command-snapshot.json`, with `teams:auth:login`
    deliberately unexposed;
  - `teams_auth_status` works through `invokeTool`;
  - the context is non-interactive;
  - an auth failure is an `isError` result naming `auth login`;
  - missing settings are reported per call.
    The `mcpClients` tests are unchanged from the template.
- **Manual**: `simply teams auth status` was run against real Graph on the spike machine (results
  above). There is no automated test against the real broker.

## Open questions

- **Which client ID?** This decides the consent and admin story, so it is the first thing to
  settle.
  - (a) A **single-tenant app registration** in our own tenant. It is the simplest to get
    approved, but every other tenant (each client tenant) needs its own registration, set
    through `TEAMS_CLIENT_ID`.
  - (b) A **published multi-tenant app** that the package ships as its default. This is the
    most seamless, but each tenant's admin must consent to `ChannelMessage.Read.All`, and the
    app's publisher becomes a trust question.
  - (c) The **Microsoft Graph Command Line Tools** first-party app (`14d82eec-…`). It is already
    broker-enabled and often already consented, but depending on another vendor's
    first-party client is brittle and may be blocked by Conditional Access. It is acceptable
    **only for the step-0 spike**.

  The recommendation is (a) now, with `TEAMS_CLIENT_ID` keeping (b) open. The spike strengthened
  it: a borrowed app's token carries every scope ever consented to that app (see Spike results).
  The registration needs:

  - the public-client redirect URI `ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-id>`;
  - only the delegated read scopes in [Scopes](#scopes);
  - admin consent for `ChannelMessage.Read.All`.

  The decision belongs to Clay and the tenant admin. Until it is made, `TEAMS_CLIENT_ID` has no
  default.

- **macOS and Linux.** Not tested: only Windows was. `msal-node-runtime` ships macOS and Linux
  broker binaries, but whether silent sign-in works through the macOS Enterprise SSO plug-in or
  the Linux identity broker (Intune-enrolled machines) is unverified. Without a broker,
  `TEAMS_ACCESS_TOKEN` is the only path today.
- **`keytar`.** It is pulled in only because of how `msal-node-extensions` builds its ESM entry,
  and it is archived upstream. Raise an issue with MSAL, or live with it?
- **Sovereign clouds.** Is GCC High or DoD needed for any client tenant in v1, or should
  `TEAMS_CLOUD` ship with `global` only and the hook documented?
- **Data-handling policy.** Does pulling Teams content into an AI agent's context need sign-off
  for any client engagement (CUI, for example), and should the tool support a tenant or team
  allowlist?
