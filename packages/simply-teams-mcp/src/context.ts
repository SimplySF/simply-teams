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

import process from 'node:process';
import { createTokenProvider } from '@simplysf/simply-teams-auth';
import {
  type EnvLike,
  GraphClient,
  loadEnvFile,
  resolveTeamsConfig,
  type TeamsConfig,
  TeamsGuard,
  type TokenProvider,
} from '@simplysf/simply-teams-core';

export interface ServerOptions {
  /**
   * Register the tools that change data. Off by default, so a server launched without thinking
   * about it can only read. Even when on, a write is still refused when the environment carries
   * `TEAMS_READ_ONLY`, exactly as the CLI refuses it.
   */
  readonly allowWrites?: boolean;
  /**
   * Clean what the agent sees (design 0005): a message holding a secret is withheld, and personal
   * data is replaced with placeholders that are put back when the agent writes. On by default;
   * `--no-clean` turns it off for a person who wants the raw text.
   */
  readonly clean?: boolean;
  /**
   * A `.env` file holding connection settings the host did not set. Loaded once, at startup,
   * with the CLI's precedence: a variable already in the environment wins over the file.
   */
  readonly envFile?: string;
  /** The environment to read settings from. Defaults to this process's; tests pass their own. */
  readonly env?: EnvLike;
  /** Supplies tokens instead of the broker. Tests pass a fake; a host can pass its own. */
  readonly tokens?: TokenProvider;
  /** Graph base URL override, for tests against a local server. */
  readonly graphBaseUrl?: string;
}

/**
 * What every tool handler gets: the environment its settings come from, and a client built from
 * it on demand. Settings are resolved per call rather than at startup so a missing or wrong one
 * is reported by the tool that needed it, rather than killing a server the host has already
 * launched.
 */
export interface ToolContext {
  readonly env: EnvLike;
  readonly allowWrites: boolean;
  /** The guard for this server's lifetime, or undefined when cleaning is off. Its map never leaves memory. */
  readonly guard: TeamsGuard | undefined;
  config(): TeamsConfig;
  tokens(): TokenProvider;
  graph(): GraphClient;
}

/** Builds the context, loading the env file first so every later lookup sees it. */
export function createContext(options: ServerOptions = {}): ToolContext {
  const env = options.env ?? process.env;
  if (options.envFile !== undefined) loadEnvFile(options.envFile, env);

  // The server never prompts (design 0001): it is a windowless child of the agent host, and a
  // sign-in window opened mid-tool-call lands behind the IDE. A sign-in that needs the user
  // fails with a pointer to `simply teams auth login` instead.
  const config = (): TeamsConfig => resolveTeamsConfig({ interactive: false }, env);

  // One provider for the server's lifetime, so its in-memory token is reused across calls until
  // it nears expiry instead of asking the broker on every tool call.
  let provider: TokenProvider | undefined = options.tokens;
  const tokens = (): TokenProvider => {
    provider ??= createTokenProvider(config());
    return provider;
  };

  return {
    env,
    allowWrites: options.allowWrites ?? false,
    // One guard per server, like one per conversation: a placeholder means the same value in every
    // result, so the agent can carry "[EMAIL-1]" from a read into a reply.
    guard: options.clean === false ? undefined : new TeamsGuard(),
    config,
    tokens,
    graph: () => new GraphClient(config(), tokens(), { baseUrl: options.graphBaseUrl }),
  };
}
