# Registering the app

simply-teams signs in through the operating system's identity broker. Microsoft Graph issues its
tokens only to an **app registration** in Entra ID, so a tenant needs one before anyone there can
sign in. You create it once per tenant. Everyone in the tenant then sets `TEAMS_CLIENT_ID` to its
application (client) ID.

The registration is not a credential. It has no secret and no certificate. It is a public client,
and every token issued to it is delegated: it acts as the signed-in person and can see only what
that person can already see in Teams.

## 1. Create the registration

In the [Entra admin center](https://entra.microsoft.com), go to **Applications → App
registrations → New registration**:

| Field                   | Value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Name                    | `simply-teams` (anything recognisable on a consent screen)    |
| Supported account types | **Accounts in this organizational directory only**            |
| Redirect URI            | leave empty for now; it needs the client ID, which comes next |

Register it, then copy the **Application (client) ID** from the overview page.

## 2. Add the broker redirect URI

Go to **Authentication → Add a platform → Mobile and desktop applications**, and add this
custom redirect URI, with your client ID in place of the placeholder:

```text
ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-id>
```

This is what lets Web Account Manager on Windows, and the Enterprise SSO plug-in on macOS, issue
tokens to the app. Without it, sign-in fails with a redirect URI mismatch.

## 3. Add exactly these permissions

Go to **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add these
six, and remove any others, including the default `User.Read` if it is listed twice:

| Permission                | Who can consent      | Needed by                                                         |
| ------------------------- | -------------------- | ----------------------------------------------------------------- |
| `User.Read`               | each user            | `auth status`, `auth login`                                       |
| `User.ReadBasic.All`      | each user            | showing senders' names                                            |
| `Chat.Read`               | each user            | `chat list`, `chat messages`, `message view` for chats            |
| `Team.ReadBasic.All`      | each user            | `team list`, finding a team by name                               |
| `Channel.ReadBasic.All`   | each user            | `channel list`, finding a channel by name                         |
| `ChannelMessage.Read.All` | **an administrator** | `message search`, `channel messages`, `message view` for channels |

**Use these exact names.** The broker does not stand in a broader grant for a narrower request: an
app consented for `Chat.ReadWrite` but not `Chat.Read` still fails a `Chat.Read` request. Nor
should it. Every scope the registration holds lands in every token it issues, so a broader grant
is more access in every agent's process for no benefit.

If you would rather edit the manifest, this is the same list as `requiredResourceAccess`. The IDs
were read from Microsoft Graph's service principal on 2026-10-21:

```json
"requiredResourceAccess": [
  {
    "resourceAppId": "00000003-0000-0000-c000-000000000000",
    "resourceAccess": [
      { "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d", "type": "Scope" },
      { "id": "b340eb25-3456-403f-be2f-af7a0d370277", "type": "Scope" },
      { "id": "f501c180-9344-439a-bca0-6cbf209fd270", "type": "Scope" },
      { "id": "485be79e-c497-4b35-9400-0e3fa7f2a5d4", "type": "Scope" },
      { "id": "9d8982ae-4365-4f57-95e9-d6032a4c0b87", "type": "Scope" },
      { "id": "767156cb-16ae-4d10-8f8b-41b657c8c8c8", "type": "Scope" }
    ]
  }
]
```

### For writing: a second registration

The write commands (`channel post`, `message reply`, `chat send`) need two more delegated
permissions, both of which a user can grant:

| Permission            | Who can consent | Needed by                       | ID                                     |
| --------------------- | --------------- | ------------------------------- | -------------------------------------- |
| `ChannelMessage.Send` | each user       | `channel post`, `message reply` | `ebf0f66e-9fb1-49e4-a278-222f76911cf4` |
| `ChatMessage.Send`    | each user       | `chat send`                     | `116b7235-7cc6-461e-b163-8e55691d839e` |

Put them on a **separate** registration, such as `simply-teams-write`, rather than on this one.
Every scope a registration holds lands in every token it issues, so adding them here would let the
agent's everyday, read-only server post too. With two registrations, the read-only one is what
binds: point the everyday MCP server at it, and use the write registration's client ID only where
posting is meant to happen. Then sign in to it with `simply teams auth login --allow-writes`.

## 4. Grant admin consent (an administrator)

`ChannelMessage.Read.All` needs a tenant administrator's consent. **Without it, Graph refuses all
message search, chats included**, along with the channel-message commands. Everything else works
without it.

An administrator can grant it from **API permissions → Grant admin consent for <tenant>**, or by
opening this link:

```text
https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<client-id>
```

You don't have to build that link yourself. Once a user has signed in, `simply teams auth login`
prints it with the right IDs filled in whenever the scope is missing. For the US government clouds,
the host is `login.microsoftonline.us`.

## 5. Sign in

```sh
export TEAMS_CLIENT_ID=<client-id>   # or put it in the --env-file you use
simply teams auth login
```

Login asks for the five user-consentable scopes, showing the broker's consent prompt the first
time. It then checks the administrator's scope without prompting. If that scope has not been
granted yet, login still succeeds, lists it under **Missing scopes**, and prints the admin-consent
link. From then on, every command and the MCP server sign in silently.

`simply teams auth status` shows the current state at any time. See [Credentials](credentials.md)
for the settings and how sign-in works.
