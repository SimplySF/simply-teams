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

/**
 * Base class for every error this CLI raises deliberately. Commands surface these through
 * oclif's `this.error(message, { exit })` so users get formatted output rather than a stack
 * trace for expected failure modes.
 */
export class CliError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Missing, malformed, or self-contradictory configuration. */
export class ConfigError extends CliError {
  public constructor(message: string) {
    super(message, 2);
    this.name = 'ConfigError';
  }
}

/**
 * Graph rejected our credentials. Carries the status because 401 and 403 call for
 * different responses: bad credentials versus a valid account without the needed permission.
 */
export class AuthError extends CliError {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message, 3);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Graph never answered: timeout, DNS miss, refused connection, or an untrusted certificate. */
export class NetworkError extends CliError {
  public constructor(message: string) {
    super(message, 1);
    this.name = 'NetworkError';
  }
}

/** Any other non-2xx response, carrying the status and whatever body came back. */
export class HttpError extends CliError {
  public readonly status: number;
  public readonly body: unknown;

  public constructor(message: string, status: number, body?: unknown) {
    super(message, 1);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
