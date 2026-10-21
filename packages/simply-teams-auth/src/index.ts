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

// Everything exported from this file is this package's public API. It exists as its own package
// so that `@simplysf/simply-teams-core` stays free of MSAL and its native broker binary
// (docs/design/0001-teams-client-core-and-auth.md). Like core, nothing here touches a terminal,
// `process.argv`, stdout, or stderr.

import { staticTokenProvider, type TeamsConfig, type TokenProvider } from '@simplysf/simply-teams-core';
import { BrokerTokenProvider, type BrokerProviderOptions } from './broker.js';

export {
  BrokerTokenProvider,
  brokerWasLoaded,
  type BrokerClient,
  type BrokerClientFactory,
  type BrokerProviderOptions,
} from './broker.js';

/**
 * Picks the token source for a resolved configuration: a supplied `TEAMS_ACCESS_TOKEN` wins,
 * since setting one is an explicit choice to bypass the broker; otherwise the broker.
 */
export function createTokenProvider(config: TeamsConfig, options: BrokerProviderOptions = {}): TokenProvider {
  return config.accessToken === undefined
    ? new BrokerTokenProvider(config, options)
    : staticTokenProvider(config.accessToken);
}
