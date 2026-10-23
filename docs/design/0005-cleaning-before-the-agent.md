# 0005 — Cleaning what an agent sees: secrets withheld, personal data placeholdered

**Status:** Implemented, unreleased
**Package:** `packages/simply-teams-core`, `packages/simply-teams-mcp`, `packages/simply-teams`
**Date:** 2026-10-22

## Problem

Everything the MCP server returns goes into an AI agent's context, and from there to whichever
model provider the agent uses. Teams messages are where people paste things they should not: a
connection string to get a colleague unblocked, an API key "just for today", a customer's phone
number. [0002](0002-read-commands.md) treats message text as untrusted for the agent's sake. Nothing
yet protects the people who wrote it, or the organisation, from that text leaving the machine.

`simply-confluence-explorer` solved the same problem for Confluence pages with an outbound guard
(its ADR-022): secrets stop a request, personal data is replaced with placeholders, and the real
values are put back on the way out. That app calls the AI itself, so the guard sits in front of the
provider. simply-teams does not call any AI. It hands results to an agent, so the guard has to sit on
what the server returns, and the "way out" is what the agent sends back: a reply, a search.

## Decision

Port the guard's detectors into core as `TeamsGuard`, dependency-free, and clean every MCP tool
result before it is returned:

- a message, search hit, chat preview or other item whose free text holds a **secret** has all of
  its free text **withheld**, replaced by `[withheld: contains a secret (AWS access key)]`. The
  item's ref, author, time and link stay, so the agent knows something was there;
- **personal data** (email addresses, phone numbers, US social security numbers, card numbers,
  IBANs) is replaced with placeholders, `[EMAIL-1]`, `[PHONE-1]`, that stay the same for the life
  of the server;
- every string in a **write tool's input** is restored first, so a reply that says "thanks
  `[EMAIL-1]`" reaches Teams with the real address, and the dry run the agent sees is cleaned again.

Cleaning is on by default in the MCP server and off by default in the CLI, where a person reading
their own Teams at a terminal sees the real text; `--clean` turns it on for a command whose output
is going to an agent.

## Behavior

### What is cleaned

| Where                           | Default | Switch                                                       |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| MCP server, every tool result   | on      | `simply teams mcp --no-clean`, `simply-teams-mcp --no-clean` |
| MCP server, `teams_auth_status` | never   | it describes this session, not a message                     |
| CLI read commands               | off     | `--clean`                                                    |
| CLI write commands              | off     | nothing to clean: the person wrote it                        |

An item is any object with free text: `text`, `subject`, `summary`, `topic`, `preview` or
`description`, plus attachment names. Identifiers (`ref`, `id`, `chatId`, `webUrl`, dates, kinds)
are never rewritten, so what the agent is shown can still be fetched, replied to and opened.

| Finding in an item's free text | Result                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| a secret                       | every free-text field of that item becomes the withheld note; attachment names are dropped; nothing else in the item changes |
| personal data                  | each value becomes a placeholder; the same value gets the same placeholder in every later result                             |
| nothing                        | the item is returned as it was                                                                                               |

A string outside any item (a warning, a planned write's content) is withheld on its own if it holds
a secret, and placeholdered otherwise.

Every cleaned result carries a `cleaned` report: `{ withheld, redacted, summary }`, where `summary`
is one sentence such as `Cleaned: 1 item withheld for holding a secret; 2 email addresses replaced
with placeholders.` or `Cleaned: nothing needed removing.` A result that is not an object is
wrapped as `{ result, cleaned }`. The server's instructions tell the agent what a withheld note and
a placeholder mean, to keep placeholders exactly as written, and that it may use one in a search or
a message.

### The detectors

Unchanged from simply-confluence-explorer, so the two tools agree on what a secret is and the corpus
test travels with them: private keys; AWS, GitHub, GitLab, Slack, Atlassian, Google, AI-provider
and Stripe tokens; JSON web tokens; connection strings with a password; Azure storage keys; and
`password = …` style assignments, with the same filter for values that only document a secret's
place (`********`, `${VAR}`, `<your password>`). Personal data: email addresses (not the user part of
a URL), US SSNs, card numbers by prefix and checksum, IBANs by checksum, US-shaped phone numbers.
`DETECTOR_TYPES` is exported so the test corpus is held to the list in both directions.

### Restoring

The guard's map (value to placeholder, and back) lives in memory for the server's lifetime and is
never returned, logged or written. `restoreInput` rewrites every string in a tool's input before the
tool runs; a placeholder the guard never issued is left as typed. The CLI's `--clean` uses a fresh
guard per command, so its placeholders cannot be restored; it is for output that is leaving.

### The secret's own value

A withheld note names the kind of secret, never the value, and the `cleaned` report carries counts.
Nothing cleaned reaches a log: the server writes nothing to disk.

## Alternatives considered

- **Refuse the whole tool call when any item holds a secret**, as the Confluence guard refuses a
  request. A channel's history would then be unreadable because of one old paste. The guard's own
  multi-page rule (leave the page out, say so) is the precedent for withholding per item.
- **Withhold only the matched value, not the whole message.** Chosen against: the words around a
  pasted credential usually say what it is for, and the message is of no use to an agent without
  the value anyway.
- **Keep placeholders in writes.** Then an agent could never answer a person it had been shown. The
  Confluence guard restores for the same reason: "an Improve proposal cannot write a placeholder
  into a page."
- **Cleaning in the agent.** Not ours to change, and agents differ; the server is the one place every
  agent passes through.
- **Clean the CLI by default too.** A person at a terminal reading their own chat would see
  `[EMAIL-1]` for a colleague they know. An agent that shells out to the CLI should pass `--clean`,
  and the MCP server is the intended route for agents.
- **A shared guard package across the SimplySF tools.** The right end state; the detectors are
  copied for now rather than published, so this record can ship without a new package. An open
  question.
- **Custom `block:`, `redact:` and `allow:` rules**, as the Confluence guard reads from a per-space
  file. Teams has no space; a tenant-wide rules file is plausible later. Not in this record.

## Implementation plan

1. Core `guard.ts`: the detectors, checksums and placeholder filter, ported; `TeamsGuard` with
   `secretsIn`, `redact`, `restore`.
2. Core `guard-results.ts`: `cleanResult` (the walk over items, identifiers left alone, the report)
   and `restoreInput`.
3. MCP: one `TeamsGuard` per server in `context.ts` (`clean` option, on by default); `invokeTool`
   restores the input, runs the tool, cleans the result and attaches `cleaned`; `--no-clean` on
   `simply teams mcp` and the bin; the instructions.
4. CLI: `cleanFlag` and `TeamsCommand.cleaned()` on every read command.
5. Docs: this record, the guides, the READMEs.

## Testing

- **core/guard**: the ported corpus, held to `DETECTOR_TYPES` both ways; each secret found by type;
  each kind of personal data placeholdered and restored; benign text untouched; placeholders stable
  across calls.
- **core/guard-results**: a message with a secret has all its free text withheld and keeps its ref
  and author; an attachment name with a secret withholds the message; personal data gets the same
  placeholder across a result; search hits and chat previews are cleaned alike; the report's
  sentence; `restoreInput` across nested input, unknown placeholders left alone.
- **MCP**: a chat read comes back cleaned with refs intact and a `cleaned` summary; a reply written
  with a placeholder reaches Graph with the real address while its dry run stays placeholdered;
  `teams_auth_status` is passed through; `--no-clean` shows raw text.
- **CLI**: `chat messages --clean` withholds, placeholders, and warns what it did.

## Open questions

- **A shared guard package.** The detectors now live in two repos. Publishing them once, from
  simply-confluence-explorer or a small `@simplysf/leak-guard`, would keep them in step.
- **Tenant rules.** Whether a `block:`/`redact:`/`allow:` file for a tenant is worth adding, and
  where it would live for a server that has no data directory.
- **Display names.** They are left alone today, since a name is what lets an agent tell people
  apart. A tenant that considers names personal data would want a rule for them.
