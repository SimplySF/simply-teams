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

// Everything exported from this file is this package's public API. The package is a stdio MCP
// server first (see bin/run.js); the programmatic surface exists so a host process can embed the
// same server over a transport of its choosing, and so tests can drive it in-memory.
export { createContext, type ServerOptions, type ToolContext } from './context.js';
export {
  createServer,
  invokeTool,
  mapError,
  selectTools,
  SERVER_NAME,
  SERVER_VERSION,
  startServer,
  type ToolError,
  type ToolErrorCode,
} from './server.js';
export { TOOLS, type ToolKind, type ToolSpec } from './tools.js';
