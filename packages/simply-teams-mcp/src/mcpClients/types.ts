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

/** Every client this module can install into, by the id `--client` takes. */
export const CLIENT_IDS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'gemini', 'codex'] as const;

export type ClientId = (typeof CLIENT_IDS)[number];

/** `user` writes the client's personal configuration; `project` its repo-level file under `cwd`. */
export type InstallScope = 'user' | 'project';

/**
 * How the entry starts the server. `absolute` runs this Node on the host's `bin/run.js`, which
 * survives a GUI client's missing `PATH` and Windows' `.cmd` shims; `simply` relies on `PATH`, which
 * is what a committed project file needs; `npx` needs no global install at all.
 */
export type Launcher = 'absolute' | 'simply' | 'npx';

/** The server to install: the entry's name and the process a client should launch. */
export type ServerSpec = {
  name: string;
  command: string;
  args: string[];
};

/**
 * Everything about the machine the plan depends on, passed in rather than read from `process` so
 * planning stays pure and every platform's paths can be tested from any one of them.
 */
export type InstallEnvironment = {
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
};

/** The top-level key a client keeps its servers under. */
export type ServersKey = 'mcpServers' | 'servers';

/** A JSON (or JSONC) configuration file to edit in place. */
export type FileInstallPlan = {
  kind: 'file';
  client: ClientId;
  scope: InstallScope;
  name: string;
  file: string;
  key: ServersKey;
  entry: Record<string, unknown>;
  /** A directory whose absence means the client isn't installed, so the file must not be created. */
  clientDir?: string;
};

/** A client whose configuration is changed through its own CLI. */
export type CliInstallPlan = {
  kind: 'cli';
  client: ClientId;
  scope: InstallScope;
  name: string;
  executable: string;
  addArgs: string[];
  removeArgs: string[];
  /** What the entry launches, compared with what is already configured. */
  launch: { command: string; args: string[] };
  /** The file the client keeps its servers in, read (never written) to find an existing entry. */
  configFile: string;
  configFormat: 'claude-json' | 'codex-toml';
};

/** A client/scope pair that has no configuration to write, e.g. Claude Desktop at project scope. */
export type UnsupportedInstallPlan = {
  kind: 'unsupported';
  client: ClientId;
  scope: InstallScope;
  name: string;
  reason: string;
};

export type InstallPlan = FileInstallPlan | CliInstallPlan | UnsupportedInstallPlan;

export type InstallOutcome = 'added' | 'replaced' | 'unchanged' | 'conflict' | 'failed';

export type InstallResult = {
  client: ClientId;
  name: string;
  outcome: InstallOutcome;
  /** The file written, or the command run (or to run). */
  target: string;
  /** True when nothing was changed because the caller asked only for the plan. */
  dryRun: boolean;
  /** 0 for added/replaced/unchanged, 2 for a conflict or a refused install, 1 for an I/O failure. */
  exitCode: 0 | 1 | 2;
  /** Why a `conflict` or `failed` happened, and what to do about it. */
  message?: string;
  /** The entry as written (or as it would be written), for display. */
  preview: string;
};

/** Runs a client's CLI. Rejects with `code: 'ENOENT'` when the executable isn't on `PATH`. */
export type ProcessRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type ApplyOptions = {
  /** Replace an existing entry of the same name that differs. */
  force?: boolean;
  /** Work out the outcome and change nothing. */
  dryRun?: boolean;
  /** Replaces the real process runner, for tests. */
  runner?: ProcessRunner;
};
