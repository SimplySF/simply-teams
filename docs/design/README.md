# Design Documents

Every new feature in this repo gets a design document here **before** it gets code. The point isn't
ceremony — it's that a year from now, the "why" behind a command's shape (why this package, why this
flag, what we rejected) is recoverable without archaeology through git history and PR threads.

## Process

1. **Write the design doc first.** Copy the [template](#template) into
   `docs/design/NNNN-short-slug.md`, using the next free four-digit number.
2. **Get agreement on it** — on the doc, not on the diff. Decisions are cheapest to change here.
3. **Implement**, then update the doc if the implementation taught you something the design got
   wrong. A design doc that quietly diverges from the shipped behavior is worse than none.
4. **Set the status line** to `Implemented` (with the PR link) when it lands.

A design doc is not a substitute for user-facing docs. Command summaries, flag descriptions, and
examples live on the command classes and each package's README and guides. The design doc records
the reasoning; the command/README records the behavior.

## When a design doc is required

- Any new command, or a new subtopic.
- Any change to an existing command's flags, output shape, or error behavior that users would
  notice.
- Any new shared module, or a change to how packages depend on each other.
- **Any change to how sign-in works**: token sources, scopes requested, when a prompt may appear,
  or what is stored. Sign-in is the part of this repo that differs most from its siblings, and the
  part where a quiet change does the most damage.

Not required for: bug fixes that restore documented behavior, dependency bumps, test-only changes,
refactors that keep the public surface identical (though a short doc is welcome for large ones).

## Index

| #    | Title                                                                                                           | Status      |
| ---- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| 0001 | [Teams client core, ambient sign-in, and package layout](0001-teams-client-core-and-auth.md)                    | In progress |
| 0002 | [Read commands: search, messages, chats, and channels](0002-read-commands.md)                                   | Implemented |
| 0003 | [Signing in before an administrator has consented](0003-consent-without-admin.md)                               | Implemented |
| 0004 | [Writes: posting, replying, and sending in a chat](0004-writes.md)                                              | Implemented |
| 0005 | [Cleaning what an agent sees: secrets withheld, personal data placeholdered](0005-cleaning-before-the-agent.md) | Implemented |

## Template

```markdown
# NNNN — Title

**Status:** Draft | Planned | In progress | Implemented (PR #N) | Superseded by NNNN
**Package:** the `packages/*` this lands in
**Date:** YYYY-MM-DD

## Problem

What the user can't do today, and why that hurts.

## Decision

The one-paragraph answer: what we're building and where it lives.

## Behavior

The user-visible contract — command name, flags, resolution rules, output, errors. Tables beat
prose for lookup rules.

## Alternatives considered

Each option we rejected and the specific reason. This section is the one future readers come back
for.

## Implementation plan

Files added/changed, in the order they'd be written.

## Testing

Unit test coverage, and what each case pins down.

## Open questions

Anything deliberately left undecided, and who decides it.
```
