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

import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { CLIENTS } from './clients.js';
import { compareClaudeEntry, compareCodexEntry, type ExistingEntry } from './existingEntry.js';
import { setNestedEntry } from './jsonEdit.js';
import { formatCommandLine, runProcess } from './runner.js';
import type {
  ApplyOptions,
  CliInstallPlan,
  FileInstallPlan,
  InstallOutcome,
  InstallPlan,
  InstallResult,
} from './types.js';

/**
 * Carries out a plan: edits the file or runs the client's CLI. Every failure becomes a `failed`
 * result rather than a rejection, so one client's problem never stops the others.
 *
 * @param plan - From `planInstall`.
 * @param options - `force` to replace a differing entry, `dryRun` to change nothing.
 * @returns What happened, or with `dryRun`, what would.
 */
export async function applyPlan(plan: InstallPlan, options: ApplyOptions = {}): Promise<InstallResult> {
  switch (plan.kind) {
    case 'file':
      return applyFilePlan(plan, options);
    case 'cli':
      return applyCliPlan(plan, options);
    case 'unsupported':
      return {
        client: plan.client,
        name: plan.name,
        outcome: 'failed',
        target: CLIENTS[plan.client].displayName,
        dryRun: Boolean(options.dryRun),
        exitCode: 2,
        message: plan.reason,
        preview: '',
      };
  }
}

async function applyFilePlan(plan: FileInstallPlan, options: ApplyOptions): Promise<InstallResult> {
  const dryRun = Boolean(options.dryRun);
  const result = (outcome: InstallOutcome, exitCode: 0 | 1 | 2, message?: string): InstallResult => ({
    client: plan.client,
    name: plan.name,
    outcome,
    target: plan.file,
    dryRun,
    exitCode,
    message,
    preview: JSON.stringify({ [plan.key]: { [plan.name]: plan.entry } }, null, 2),
  });

  const config = await readConfigFile(plan);
  if ('failure' in config) return result('failed', config.exitCode, config.failure);
  const { text, servers } = config;

  const existing = servers?.[plan.name];
  if (existing !== undefined) {
    if (isDeepStrictEqual(existing, plan.entry)) return result('unchanged', 0);
    if (!options.force) return result('conflict', 2, conflictMessage(plan.name, plan.file));
  }
  const outcome = existing === undefined ? 'added' : 'replaced';
  if (dryRun) return result(outcome, 0);

  try {
    const updated = setNestedEntry(text ?? '', plan.key, plan.name, plan.entry);
    await fs.mkdir(path.dirname(plan.file), { recursive: true });
    if (text !== undefined) await fs.copyFile(plan.file, `${plan.file}.bak`);
    await writeAtomically(plan.file, updated);
  } catch (error) {
    return result('failed', 1, `Could not write ${plan.file}: ${(error as Error).message}`);
  }
  return result(outcome, 0);
}

type ConfigFile =
  { text: string | undefined; servers: Record<string, unknown> | undefined } | { failure: string; exitCode: 1 | 2 };

/** Reads and checks a client's file: absent is fine, unreadable or not an object is a refusal. */
async function readConfigFile(plan: FileInstallPlan): Promise<ConfigFile> {
  let text: string | undefined;
  try {
    text = await fs.readFile(plan.file, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) return { failure: `Could not read ${plan.file}: ${(error as Error).message}`, exitCode: 1 };
  }

  if (text === undefined && plan.clientDir && !(await isDirectory(plan.clientDir))) {
    return {
      failure: `${CLIENTS[plan.client].displayName} does not appear to be installed: ${plan.clientDir} does not exist.`,
      exitCode: 2,
    };
  }

  const errors: ParseError[] = [];
  const root: unknown =
    text === undefined || text.trim() === '' ? {} : parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    return {
      failure:
        `${plan.file} is not valid JSON (${printParseErrorCode(first.error)} at offset ${first.offset}). ` +
        'It was left untouched; fix it and run this again.',
      exitCode: 2,
    };
  }
  if (!isRecord(root) || (root[plan.key] !== undefined && !isRecord(root[plan.key]))) {
    return {
      failure: `${plan.file} does not hold an object${isRecord(root) ? ` under "${plan.key}"` : ''}. It was left untouched.`,
      exitCode: 2,
    };
  }
  return { text, servers: root[plan.key] as Record<string, unknown> | undefined };
}

async function applyCliPlan(plan: CliInstallPlan, options: ApplyOptions): Promise<InstallResult> {
  const dryRun = Boolean(options.dryRun);
  const addCommand = formatCommandLine(plan.executable, plan.addArgs);
  const removeCommand = formatCommandLine(plan.executable, plan.removeArgs);
  const result = (
    outcome: InstallOutcome,
    exitCode: 0 | 1 | 2,
    message?: string,
    target = addCommand,
  ): InstallResult => ({
    client: plan.client,
    name: plan.name,
    outcome,
    target,
    dryRun,
    exitCode,
    message,
    preview: addCommand,
  });

  const existing = await readExistingCliEntry(plan);
  if (existing === 'same') return result('unchanged', 0);
  if (existing === 'differs' && !options.force)
    return result('conflict', 2, conflictMessage(plan.name, plan.configFile));

  const outcome = existing === 'absent' ? 'added' : 'replaced';
  const commands = existing === 'absent' ? [plan.addArgs] : [plan.removeArgs, plan.addArgs];
  const target = existing === 'absent' ? addCommand : `${removeCommand} && ${addCommand}`;
  if (dryRun) return result(outcome, 0, undefined, target);

  const run = options.runner ?? runProcess;
  for (const args of commands) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the remove must finish before the add, or the add sees the old entry
      const { exitCode, stderr, stdout } = await run(plan.executable, args);
      if (exitCode !== 0) {
        const output = (stderr || stdout).trim();
        return result(
          'failed',
          1,
          `${formatCommandLine(plan.executable, args)} exited with ${exitCode}${output ? `: ${output}` : '.'}`,
          target,
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        return result(
          'failed',
          2,
          `${plan.executable} is not on PATH, so ${CLIENTS[plan.client].displayName} could not be configured. ` +
            `Run this yourself:\n${target}`,
          target,
        );
      }
      return result('failed', 1, `Could not run ${plan.executable}: ${(error as Error).message}`, target);
    }
  }
  return result(outcome, 0, undefined, target);
}

async function readExistingCliEntry(plan: CliInstallPlan): Promise<ExistingEntry> {
  let text: string;
  try {
    text = await fs.readFile(plan.configFile, 'utf8');
  } catch {
    // No file means no entry; any other read problem is the client's to report when it runs.
    return 'absent';
  }
  return plan.configFormat === 'claude-json'
    ? compareClaudeEntry(text, plan.name, plan.launch)
    : compareCodexEntry(text, plan.name, plan.launch);
}

/** Writes beside the target and renames over it, so a crash never leaves a half-written file. */
async function writeAtomically(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, 'utf8');
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function conflictMessage(name: string, file: string): string {
  return `An entry named "${name}" already exists in ${file} and is different. Re-run with --force to replace it.`;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
