/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { AuthenticationResult, InteractiveRequest } from '@azure/msal-node';
import {
  type AccessToken,
  AuthError,
  BASE_SCOPES,
  ConfigError,
  graphScopes,
  type TeamsConfig,
  type TokenProvider,
  type TokenRequest,
} from '@simplysf/simply-teams-core';

/** The one MSAL call this provider makes. `PublicClientApplication` satisfies it; tests fake it. */
export interface BrokerClient {
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>;
}

/** Builds the MSAL client. Replaced in tests so the native broker binary is never loaded there. */
export type BrokerClientFactory = (config: TeamsConfig) => Promise<BrokerClient>;

export interface BrokerProviderOptions {
  readonly createClient?: BrokerClientFactory;
  /** Clock seam for cache-expiry tests. */
  readonly now?: () => Date;
}

/** Reuse a cached token only while it has at least this long left, so it cannot expire in flight. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

/** Errors MSAL raises when the broker needs the user, rather than when something is broken. */
const NEEDS_USER = /interaction_required|consent_required|login_required|InteractionRequired/i;

const LOGIN_HINT = 'Run "simply teams auth login" once in a terminal, then try again.';

let brokerLoaded = false;

/**
 * Whether this process has loaded the native broker. The broker registers a native logging
 * callback that nothing can unregister, which keeps Node's event loop alive for good; the CLI
 * checks this to know it must end the process itself once a command is done.
 */
export function brokerWasLoaded(): boolean {
  return brokerLoaded;
}

/**
 * The real factory. MSAL is imported here, lazily, so that importing this package costs nothing
 * for a caller that uses `TEAMS_ACCESS_TOKEN`, and unit tests never load the native binary.
 */
const defaultFactory: BrokerClientFactory = async (config) => {
  const [{ PublicClientApplication }, { NativeBrokerPlugin }] = await Promise.all([
    import('@azure/msal-node'),
    import('@azure/msal-node-extensions'),
  ]);
  const broker = new NativeBrokerPlugin();
  // msal-node quietly falls back to a browser sign-in when the broker fails to start. That
  // fallback is a loopback web server and a browser tab: not the seamless sign-in this tool
  // promises, and impossible from the MCP server. Refuse it up front instead.
  if (!broker.isBrokerAvailable) {
    throw new ConfigError(
      'No operating-system sign-in broker is available on this machine (Web Account Manager on Windows, ' +
        'the Enterprise SSO plug-in on macOS). Set TEAMS_ACCESS_TOKEN to a Microsoft Graph access token instead.',
    );
  }
  brokerLoaded = true;
  return new PublicClientApplication({
    auth: { clientId: config.clientId ?? '', authority: `${config.endpoints.loginUrl}/${config.tenantId}` },
    broker: { nativeBrokerPlugin: broker },
  });
};

/** A second guard on the browser fallback: if MSAL ever reaches for a browser, fail instead. */
function refuseBrowser(): Promise<void> {
  return Promise.reject(new ConfigError('Sign-in tried to open a browser; this CLI signs in only through the broker.'));
}

/** MSAL errors carry `errorCode` and a multi-line `errorMessage`; the first line is the useful one. */
function describe(error: unknown): string {
  const { errorCode, errorMessage, message } = error as { errorCode?: string; errorMessage?: string; message?: string };
  const text = (errorMessage ?? message ?? String(error)).split('\n')[0]?.trim() ?? '';
  return [errorCode, text].filter((part) => part !== undefined && part !== '').join(': ');
}

/**
 * Graph tokens from the operating system's identity broker: Web Account Manager on Windows,
 * the Enterprise SSO plug-in on macOS (design 0001, Token acquisition).
 *
 * Silent first, as the account Windows is signed in with: with no account named, the broker's
 * `prompt: 'none'` path signs in as the default OS account, which on an Entra-joined machine
 * needs no input at all. The refresh token stays inside the broker, bound to the device, so this
 * provider stores nothing; it only caches the short-lived access token in memory.
 */
export class BrokerTokenProvider implements TokenProvider {
  private readonly config: TeamsConfig;
  private readonly createClient: BrokerClientFactory;
  private readonly now: () => Date;
  private client: Promise<BrokerClient> | undefined;
  /** Keyed by the requested scope set, since each set is its own token request to the broker. */
  private readonly cache = new Map<string, AccessToken>();

  public constructor(config: TeamsConfig, options: BrokerProviderOptions = {}) {
    if (config.clientId === undefined) {
      throw new ConfigError('The broker needs an application (client) ID to sign in for. Set TEAMS_CLIENT_ID.');
    }
    this.config = config;
    this.createClient = options.createClient ?? defaultFactory;
    this.now = options.now ?? ((): Date => new Date());
  }

  public async getToken(request: TokenRequest = {}): Promise<AccessToken> {
    const wanted = [...(request.scopes ?? BASE_SCOPES)].sort();
    const key = wanted.join(' ');
    const cached = this.cache.get(key);
    if (
      request.forceRefresh !== true &&
      cached?.expiresOn !== undefined &&
      cached.expiresOn.getTime() - this.now().getTime() > EXPIRY_MARGIN_MS
    ) {
      return cached;
    }

    // Memoised as a promise so concurrent first calls share one client instead of racing.
    this.client ??= this.createClient(this.config);
    const client = await this.client;
    const scopes = graphScopes(this.config.endpoints, wanted);

    let result: AuthenticationResult;
    try {
      result = await client.acquireTokenInteractive({ scopes, prompt: 'none', openBrowser: refuseBrowser });
    } catch (error) {
      if (!NEEDS_USER.test(describe(error))) throw new AuthError(`Sign-in failed: ${describe(error)}`, 401);
      if (!this.config.interactive || request.silentOnly === true) {
        throw new AuthError(`Sign-in needs you to confirm it once (${describe(error)}). ${LOGIN_HINT}`, 401);
      }
      // No prompt value: the broker signs in silently if it can and shows its account picker
      // only if it must. On an Entra-joined machine that is one click, never a password.
      try {
        result = await client.acquireTokenInteractive({ scopes, openBrowser: refuseBrowser });
      } catch (interactiveError) {
        throw new AuthError(`Sign-in did not complete: ${describe(interactiveError)}`, 401);
      }
    }

    const token: AccessToken = {
      token: result.accessToken,
      source: 'broker',
      expiresOn: result.expiresOn ?? undefined,
      account: result.account?.username,
      tenantId: result.tenantId || result.account?.tenantId,
      scopes: result.scopes,
    };
    this.cache.set(key, token);
    return token;
  }
}
