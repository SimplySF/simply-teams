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

// The knowledge of MCP clients — where each keeps its configuration, what shape it wants, and how to
// edit it without destroying the rest — behind `teams mcp install`. See
// docs/design/0010-mcp-install.md. simply-atlassian keeps an identical copy for `atlassian mcp install`:
// change both together. Like the core package, nothing here writes to stdout or stderr or reads
// process.argv: it plans, applies, and returns text for the caller to print.

export {
  CLIENT_IDS,
  type ApplyOptions,
  type ClientId,
  type CliInstallPlan,
  type FileInstallPlan,
  type InstallEnvironment,
  type InstallOutcome,
  type InstallPlan,
  type InstallResult,
  type InstallScope,
  type Launcher,
  type ProcessRunner,
  type ServerSpec,
  type ServersKey,
  type UnsupportedInstallPlan,
} from './types.js';
export { CLIENTS } from './clients.js';
export { planInstall, isValidServerName } from './plan.js';
export { applyPlan } from './apply.js';
export { installServer, exitCodeFor, detectInstalledClients, isClientId } from './install.js';
export { buildLaunch, currentEnvironment, defaultLauncher, resolveEnvFile, SIMPLY_CLI_PACKAGE } from './launch.js';
export { formatInstallReport, formatClientChoices } from './report.js';
export { formatCommandLine, runProcess } from './runner.js';
