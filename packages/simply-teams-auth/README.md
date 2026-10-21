# @simplysf/simply-teams-auth

Seamless Microsoft Graph sign-in for [`simply-teams`](../simply-teams), through the operating
system's identity broker: Web Account Manager (WAM) on Windows, the Enterprise SSO plug-in on macOS.

It signs in as the account the operating system is already signed in with. On an Entra ID–joined
machine that needs no input at all. It implements the `TokenProvider` interface from
[`@simplysf/simply-teams-core`](../simply-teams-core), and it is the only package in the repo that
depends on MSAL.

```sh
npm install @simplysf/simply-teams-auth
```

## Usage

```ts
import { createTokenProvider } from '@simplysf/simply-teams-auth';
import { GraphClient, resolveTeamsConfig } from '@simplysf/simply-teams-core';

const config = resolveTeamsConfig({ interactive: false });
const tokens = createTokenProvider(config); // the broker, or TEAMS_ACCESS_TOKEN if set
const me = await new GraphClient(config, tokens).me();
```

## How a token is acquired

`createTokenProvider(config)` returns a fixed-token provider when `TEAMS_ACCESS_TOKEN` is set.
Otherwise it returns a `BrokerTokenProvider`, whose `getToken({ scopes })` works like this:

1. **Cache.** It reuses an access token held in memory for the same scope set while it has more
   than five minutes left.
2. **Silent sign-in.** It calls MSAL's `acquireTokenInteractive({ prompt: 'none' })` without naming
   an account. With no account, the broker signs in silently as the operating system's default
   account. After the first time, this takes tens of milliseconds, in any process.
3. **The broker's own prompt.** This step runs only when the config allows interaction
   (`interactive: true`) and the broker reports that it needs the user, for example for first-time
   consent or a Conditional Access check. It shows the broker's account picker. On a joined machine
   that is one click, never a password.
4. **Otherwise,** it fails with an `AuthError` (exit code 3) that says to run
   `simply teams auth login`.

Each call asks only for the scopes it names, with `User.Read` as the default. The broker's token
still lists every scope the user has consented to.

## Guarantees

- **No browser fallback.** msal-node quietly falls back to a loopback server and a browser tab
  when the broker fails to start. This package refuses that: an unavailable broker is a
  `ConfigError` that names `TEAMS_ACCESS_TOKEN`, and the `openBrowser` callback it hands MSAL always
  throws.
- **Nothing on disk.** The refresh token stays inside the broker, bound to the device. This package
  holds only short-lived access tokens, and only in memory.
- **Lazy loading.** MSAL and the native broker binary are imported on the first `getToken()` call.
  Importing the package, or using `TEAMS_ACCESS_TOKEN`, never loads them.

## The event-loop caveat

Once loaded, the broker registers a native logging callback that cannot be unregistered, so **Node
never exits on its own afterwards.** `brokerWasLoaded()` reports whether that has happened. A
short-lived program has to end the process itself once its work is done. The `simply teams` CLI
does this with an unref'd timer in its base command. A long-lived server needs nothing.

## Native dependencies

- **Broker binaries.** These come prebuilt inside `@azure/msal-node-runtime` for Windows, macOS, and
  Linux, so nothing is compiled at install.
- **`keytar`.** `@azure/msal-node-extensions` imports it eagerly from its ESM entry point, so its
  install script must be allowed to run and download a prebuilt binary. This package does not use
  keytar's credential storage.

## Documentation

- [Sign-in design (0001)](../../docs/design/0001-teams-client-core-and-auth.md)
- [Credentials guide](../simply-teams/docs/guides/credentials.md)
- [Contributing](./CONTRIBUTING.md)

## License

Apache-2.0.
