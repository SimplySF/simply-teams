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
import { Command, Flags, type Interfaces } from '@oclif/core';
import { brokerWasLoaded, createTokenProvider } from '@simplysf/simply-teams-auth';
import {
  assertWritesAllowed,
  AuthError,
  cleanResult,
  CliError,
  CLOUDS,
  type ConfigOverrides,
  GraphClient,
  HttpError,
  loadEnvFile,
  redactSecrets,
  resolveTeamsConfig,
  sanitiseDeep,
  secretValues,
  stripControl,
  type TeamsConfig,
  TeamsGuard,
  type TokenProvider,
} from '@simplysf/simply-teams-core';

/**
 * How long a finished command may linger before the process is ended for it. The timer is
 * unref'd, so it only fires when something other than our own work is holding the event loop
 * open — which, once the broker is loaded, it always is.
 */
const BROKER_EXIT_GRACE_MS = 500;

/** Names the failure for a machine reader: our own errors keep their class name. */
function errorName(error: unknown, oclifExit: number | undefined): string {
  if (error instanceof CliError) return error.name;
  return oclifExit === undefined ? 'Error' : 'UsageError';
}

/**
 * Cleaning for a person who pipes a read command to an agent (design 0005). The MCP server cleans
 * by default; at a terminal, a person reading their own Teams sees the real text unless they ask.
 */
export const cleanFlag = {
  clean: Flags.boolean({
    summary:
      'Withhold messages that hold a secret and replace personal data with placeholders, as the MCP server does.',
    default: false,
  }),
};

/** The paging ceiling, worded once so every list command reads the same. */
export function limitFlag(fallback: number, what: string): { limit: Interfaces.OptionFlag<number> } {
  return {
    limit: Flags.integer({
      summary: `Maximum number of ${what} to return across all pages.`,
      default: fallback,
      min: 1,
    }),
  };
}

/**
 * Connection flags. There is deliberately no flag for a token: `TEAMS_ACCESS_TOKEN` is read from
 * the environment only, so a token never sits in `process.argv`, shell history, or a process
 * listing. The broker is the normal path and needs no secret at all.
 */
const teamsFlags = {
  'env-file': Flags.string({
    char: 'e',
    summary: 'Path to a .env file holding connection settings.',
    description:
      'Loaded before anything else. Variables already present in the environment win, so the ' +
      'file never overrides an explicit export, and only simply-teams settings are read from it. ' +
      'A path that cannot be read is an error.',
    helpGroup: 'CONNECTION',
  }),
  'client-id': Flags.string({
    summary: 'Application (client) ID of the Entra app registration to sign in for.',
    env: 'TEAMS_CLIENT_ID',
    helpGroup: 'CONNECTION',
  }),
  tenant: Flags.string({
    summary: 'Tenant GUID or domain. Defaults to the home tenant of the account you are signed in with.',
    env: 'TEAMS_TENANT_ID',
    helpGroup: 'CONNECTION',
  }),
  cloud: Flags.string({
    summary: 'Microsoft cloud to use. GCC Moderate tenants use global.',
    options: Object.keys(CLOUDS),
    env: 'TEAMS_CLOUD',
    helpGroup: 'CONNECTION',
  }),
};

export type TeamsFlags<T extends typeof Command> = Interfaces.InferredFlags<typeof teamsFlags & T['flags']>;
export type CommandArgs<T extends typeof Command> = Interfaces.InferredArgs<T['args']>;

/**
 * Everything every command shares: `--json` (oclif prints whatever `run()` returns, verbatim),
 * the connection flags, `--env-file` loading, sign-in, and turning failures into stable exit
 * codes without letting anything reach stdout.
 */
export abstract class TeamsCommand<T extends typeof Command> extends Command {
  public static override enableJsonFlag = true;
  public static override baseFlags = teamsFlags;

  /**
   * Set by any command that changes data. The read-only guard is then enforced centrally in
   * `init()`, so a future write command cannot forget to call it.
   */
  public static isWrite = false;

  /**
   * Whether this command may open a sign-in window. Only `teams auth login` sets it: every other
   * command fails with a pointer to that one, so a sign-in window never appears in the middle
   * of something a script or an agent started.
   */
  public static interactiveSignIn = false;

  protected args!: CommandArgs<T>;
  protected rawFlags: Record<string, unknown> = {};
  private tokenProvider: TokenProvider | undefined;

  protected get flags(): TeamsFlags<T> {
    return this.rawFlags as TeamsFlags<T>;
  }

  public override async init(): Promise<void> {
    await super.init();
    const { args, flags } = await this.parse({
      baseFlags: (this.constructor as typeof TeamsCommand).baseFlags,
      flags: this.ctor.flags,
      enableJsonFlag: this.ctor.enableJsonFlag,
      args: this.ctor.args,
      strict: this.ctor.strict,
    });
    this.args = args as CommandArgs<T>;
    this.rawFlags = flags;

    // Applied here, before anything reads configuration, so every later lookup sees the file.
    const envFile = this.rawFlags['env-file'];
    if (typeof envFile === 'string') loadEnvFile(envFile);

    // After the env file, so a read-only guard carried in a credential file is honoured, and
    // before run(), so no write command can issue a request first.
    if ((this.constructor as typeof TeamsCommand).isWrite) assertWritesAllowed();
  }

  /**
   * The native broker registers a logging callback that cannot be unregistered, so once it is
   * loaded Node never exits on its own. The command's output has been written by the time
   * `finally` runs; the unref'd timer only fires if the broker is what is keeping us alive.
   */
  public override async finally(error: Error | undefined): Promise<unknown> {
    const result: unknown = await super.finally(error);
    if (brokerWasLoaded()) {
      setTimeout(() => {
        process.exit();
      }, BROKER_EXIT_GRACE_MS).unref();
    }
    return result;
  }

  /** Explicit flags outrank the environment, which outranks the `--env-file` contents. */
  protected teamsConfig(): TeamsConfig {
    const overrides: ConfigOverrides = {
      clientId: this.flagValue('client-id'),
      tenantId: this.flagValue('tenant'),
      cloud: this.flagValue('cloud'),
      interactive: (this.constructor as typeof TeamsCommand).interactiveSignIn,
    };
    return resolveTeamsConfig(overrides);
  }

  /** One provider per command, so its in-memory token is shared by every request the command makes. */
  protected tokens(config: TeamsConfig = this.teamsConfig()): TokenProvider {
    this.tokenProvider ??= createTokenProvider(config);
    return this.tokenProvider;
  }

  protected graph(config: TeamsConfig = this.teamsConfig()): GraphClient {
    return new GraphClient(config, this.tokens(config));
  }

  /**
   * Turns any failure into one compact, machine-readable line on stderr plus a stable exit
   * code, and never lets a failure reach stdout.
   *
   * This has to cover *every* error, not just this CLI's own: oclif's default `--json` error
   * path serializes its whole parse context — including the raw argv — to stdout. For a caller
   * that captures stdout into an AI agent's context, that is a disclosure, so the default path
   * is never taken here.
   *
   * Exit codes stay identical with and without `--json`: 2 config or usage, 3 auth, 1
   * everything else.
   */
  protected override async catch(error: Interfaces.CommandError): Promise<unknown> {
    // oclif attaches its own exit code to usage errors; reuse it so --json and plain runs agree.
    const oclifExit = (error as { oclif?: { exit?: number } }).oclif?.exit;
    const exitCode = error instanceof CliError ? error.exitCode : (oclifExit ?? 1);
    // Error text can quote a Graph response body. Control-stripped but NOT collapsed to one line:
    // newlines here are this CLI's own. Server-supplied text is made single-line where it is
    // interpolated instead — see `formatSnippet` in core/http.ts.
    const redact = secretValues();
    const message = stripControl(redactSecrets(error.message, redact));

    if (this.jsonEnabled()) {
      // Written straight to the stream: oclif silences this.log/logToStderr under --json.
      process.stderr.write(
        `${JSON.stringify({
          error: {
            name: errorName(error, oclifExit),
            message,
            exitCode,
            ...(error instanceof HttpError ? { status: error.status, body: sanitiseDeep(error.body, redact) } : {}),
            ...(error instanceof AuthError ? { status: error.status } : {}),
          },
        })}\n`,
      );
      this.exit(exitCode);
    }

    if (error instanceof CliError) {
      this.error(message, { exit: exitCode, code: error.name });
    }
    // An unexpected error would otherwise reach oclif's default handler carrying the original,
    // unsanitised and unredacted text. Rethrow the sanitised message instead, preserving the
    // exit code oclif attached.
    const sanitised = new Error(message);
    Object.assign(sanitised, { oclif: { exit: exitCode } });
    return super.catch(sanitised);
  }

  /**
   * Logs a line that contains server-supplied text. Everything Graph returned is stripped of
   * control characters first — the same treatment error output gets, and for the same reason:
   * this stream is parsed by an agent, and a bare escape sequence can make what a person sees
   * differ from what the agent ingests. Teams messages are written by anyone in the chat.
   */
  protected logSafe(message: string): void {
    this.log(stripControl(redactSecrets(message, secretValues())));
  }

  /** Applies `--clean` to a result before it is rendered or returned; without the flag, returns it as is. */
  protected cleaned<R>(value: R): R {
    if (this.rawFlags.clean !== true) return value;
    const { value: clean, report } = cleanResult(new TeamsGuard(), value);
    if (report.withheld > 0 || Object.keys(report.redacted).length > 0) this.warn(report.summary);
    // Under --json the warning is silenced, so the report rides with the result, as it does from
    // the MCP server.
    if (typeof clean === 'object' && clean !== null && !Array.isArray(clean)) {
      return { ...clean, cleaned: report };
    }
    return clean;
  }

  /** Renders a list result and says plainly whether the limit cut it short. */
  protected reportList(count: number, complete: boolean, limit: number, what: string): void {
    const note = complete ? '' : ` (limit ${limit} reached; more available)`;
    this.log(`\nShowing ${count} ${what}${note}.`);
  }

  /** Narrowed accessor so subclasses read flags without casting at every use. */
  protected flagValue(name: string): string | undefined {
    const value = this.rawFlags[name];
    return typeof value === 'string' ? value : undefined;
  }
}
