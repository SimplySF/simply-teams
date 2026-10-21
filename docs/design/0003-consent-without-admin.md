# 0003 — Signing in before an administrator has consented

**Status:** Implemented, unreleased (not yet run against a real app registration)
**Package:** `packages/simply-teams-core`, `packages/simply-teams-auth`, `packages/simply-teams`
**Date:** 2026-10-21

## Problem

`teams auth login` asks the broker for all six read scopes at once (0001). One of them,
`ChannelMessage.Read.All`, needs an administrator's consent. Until that consent is granted, the
broker cannot complete the request: it can only show "Need admin approval". The other five scopes
fail with it, even though the user could consent to every one of them.

So the commands that never needed an administrator stay unusable too: `chat list`,
`chat messages`, chat `message view`, `team list` and `channel list`. Admin consent can take weeks,
and 0002 already names `chat messages --since` as the way through in the meantime. Today that way
through is blocked at the very first step.

Separately, there is no written procedure for creating the app registration, and 0001's open
question 1 cannot be settled without one.

## Decision

`auth login` signs in in two steps.

1. **Interactively, for the scopes a user can grant:** `User.Read`, `User.ReadBasic.All`,
   `Chat.Read`, `Team.ReadBasic.All` and `Channel.ReadBasic.All`.
2. **Silently only, for `ChannelMessage.Read.All`.** If that fails, login still succeeds. It
   reports the scope as missing and prints the tenant's **admin-consent URL** for the app, for a
   person to forward to an administrator.

A new guide, `docs/guides/app-registration.md`, gives the exact registration: redirect URI, the
delegated permissions with their IDs, and the admin-consent link.

## Behavior

### Scopes, split by who can grant them

The split was checked against Graph's own service principal in the tenant on 2026-10-21, from
`oauth2PermissionScopes[].type`:

| Scope                     | Permission ID                          | Consent |
| ------------------------- | -------------------------------------- | ------- |
| `User.Read`               | `e1fe6dd8-ba31-4d61-89e7-88639da4683d` | User    |
| `User.ReadBasic.All`      | `b340eb25-3456-403f-be2f-af7a0d370277` | User    |
| `Chat.Read`               | `f501c180-9344-439a-bca0-6cbf209fd270` | User    |
| `Team.ReadBasic.All`      | `485be79e-c497-4b35-9400-0e3fa7f2a5d4` | User    |
| `Channel.ReadBasic.All`   | `9d8982ae-4365-4f57-95e9-d6032a4c0b87` | User    |
| `ChannelMessage.Read.All` | `767156cb-16ae-4d10-8f8b-41b657c8c8c8` | Admin   |

Core exports the split as `USER_CONSENT_SCOPES` and `ADMIN_CONSENT_SCOPES`. `READ_SCOPES` stays as
their union, so nothing that uses it changes.

### `auth login`

| Step | Request                                                | On failure                                                                             |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1    | `USER_CONSENT_SCOPES`; interactive allowed, as in 0001 | Fails as before: `AuthError`, exit 3.                                                  |
| 2    | `ADMIN_CONSENT_SCOPES`, **silent only**                | Not a failure. The scope is left out, and the status reports it under `missingScopes`. |
| 3    | `authStatus` (unchanged)                               | As before.                                                                             |

Step 2 is silent even though login is the one command allowed to prompt. When admin consent is
missing, a prompt can only show "Need admin approval", which the user cannot get past. A silent
check asks the same question without that dead end.

`TokenRequest` gains `silentOnly?: boolean`. `BrokerTokenProvider` honours it by skipping the
interactive fallback. A static token ignores it, since it never prompts anyway.

### The admin-consent URL

When `ChannelMessage.Read.All` is missing, login's result carries `adminConsentUrl`:
`{loginUrl}/{tenantId}/adminconsent?client_id={clientId}`. It is built only when both a client ID
and a concrete tenant ID are known; `organizations` is resolved from the token's `tid` claim. That
v1 endpoint grants every permission the registration lists, which is why the guide requires the
registration to list exactly the six scopes above.

It is printed by **`auth login` only**, for a person to forward. `auth status` and the MCP tool
still report the missing scope without advice, for the reason 0001 gives: an agent told how to
get more access would be escalating its own.

## Alternatives considered

- **Request the admin scope interactively, and let the broker show "Need admin approval".** That
  is today's behavior, and it blocks the five user scopes along with it. It also gives no link to
  forward.
- **Leave `ChannelMessage.Read.All` out of login entirely**, and let `message search` prompt for
  it the first time it is used. But only login may prompt (0001). Search would fail anyway, with
  the same 403, and the user would learn about the gap mid-task rather than at login.
- **Create the app registration from this CLI** (`teams app register`). The signed-in user would
  need `Application.ReadWrite.All` and permission to register apps in the tenant. It is a one-time
  admin task, and owning tenant writes is out of scope for a read-only tool. A guide does the job.

## Implementation plan

1. **Core `token.ts`:** `USER_CONSENT_SCOPES`, `ADMIN_CONSENT_SCOPES`,
   `TokenRequest.silentOnly`.
2. **Core `auth-status.ts`:**
   - `adminConsentUrl(config, tenantId)`.
   - `signIn(config, tokens, graph)`, which runs the three steps and returns
     `AuthStatus & { adminConsentUrl? }`.
3. **Auth `broker.ts`:** honour `silentOnly`.
4. **CLI `auth login`:** call `signIn`, and print the link with one sentence saying what it is
   for.
5. **Docs:** a new `docs/guides/app-registration.md`, plus links to it from the credentials guide
   and the READMEs.

## Testing

- **broker:** with `silentOnly`, an `interaction_required` result raises `AuthError` without a
  second, interactive call, even when the configuration allows prompting.
- **signIn** (fake provider plus a local Graph server):
  - the user scopes are requested first and interactively;
  - the admin scope is requested silently;
  - if the admin scope fails, login still succeeds and returns `adminConsentUrl` with the
    concrete tenant ID;
  - with every scope granted, there is no URL;
  - with `organizations` and no `tid`, there is no URL;
  - a failure in step 1 still fails login.
- **CLI:** `auth login --json` includes `adminConsentUrl` only when the scope is missing.

## Open questions

- Is "Allow public client flows" required on the registration for WAM? The broker redirect URI is
  documented as the requirement and the flow is not ROPC or device code, so probably not. Confirm
  when the registration is first created.
