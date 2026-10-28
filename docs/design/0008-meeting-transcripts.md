# 0008 — Meeting transcripts: what was said in the call, not just the chat

**Status:** Implemented, unreleased
**Package:** `packages/simply-teams-core`, `packages/simply-teams`, `packages/simply-teams-mcp`
**Date:** 2026-10-26

## Problem

The decisions this tool exists to find ([0001](0001-teams-client-core-and-auth.md)) are often made
on a call. What reaches the chat afterwards is a link, "as discussed", or nothing. Teams records a
transcript of any meeting where transcription was turned on, and Graph serves it, but nothing here
reads it: `chat messages` on a meeting chat returns the side conversation, and 0001 and
[0002](0002-read-commands.md) left transcripts "out of scope, with their own doc". This is that doc.

A transcript is long. An hour of talk is sixty to eighty thousand characters, three times the
budget [0006](0006-message-context.md) allows a whole `message context` result. Handing an agent
the whole thing answers one question by making the next ten impossible, so the command has to
narrow as well as fetch.

## Decision

Add a `meeting` topic with two read commands. `meeting list` names the meetings the user was in,
which are already visible as meeting chats, so it needs no new scope. `meeting transcript` turns a
meeting link, a meeting chat, or a ref from either list into the meeting's transcript: the words,
who said them and when, within a character budget, optionally narrowed to the utterances that
contain given words and their surroundings. Two scopes join the read set: `OnlineMeetings.Read`,
which a user can grant and which resolves a join link to a meeting, and
`OnlineMeetingTranscript.Read.All`, which an administrator grants, in the same request as
`ChannelMessage.Read.All`.

## Behavior

### Commands

| CLI                                  | MCP tool                   | Scopes                                                                 |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| `teams meeting list`                 | `teams_meeting_list`       | `Chat.Read`                                                            |
| `teams meeting transcript <meeting>` | `teams_meeting_transcript` | `Chat.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` |

### `meeting list`

The meeting chats among the user's chats, most recently active first: 0002's `chat list` filtered
to `type: "meeting"`, with Graph's `onlineMeetingInfo` read from each. Nothing else: Graph has no
"meetings I attended" list short of the calendar, and the calendar is a scope (`Calendars.ReadBasic`)
and a surface this tool has no other reason to touch.

| Flag / input        | Default      | Meaning                     |
| ------------------- | ------------ | --------------------------- |
| `--limit` / `limit` | 20 (max 100) | How many meetings to return |

Each meeting: `ref` (the meeting chat's ref, which `meeting transcript`, `chat messages` and
`chat send` all accept), `subject` (the chat's topic), `organizer`, `joinUrl`, `lastActivity`
(the chat's last message time) and `chatRef`. A meeting with no transcript still appears; whether
one exists is only known by asking for it. `complete` is false when more meeting chats remained
after the scan's page ceiling.

### `meeting transcript`

`<meeting>` is any of: a Teams meeting link (`…/l/meetup-join/19%3ameeting_…%40thread.v2/…`), a
meeting chat link or ref (`19:meeting_…@thread.v2`, or `chatId/messageId` from a search hit in a
meeting chat), or a `ref` from `meeting list`. All three name the meeting chat; the join link
carries the chat's ID in its path. Resolution is one fixed path, so every input behaves the same:

1. `GET /chats/{id}` (`Chat.Read`) for `onlineMeetingInfo.joinWebUrl`. A chat without it is
   refused: "not a meeting chat".
2. `GET /me/onlineMeetings?$filter=JoinWebUrl eq '{joinWebUrl}'` (`OnlineMeetings.Read`) for the
   meeting's ID, subject, start and end, and organizer. Graph accepts an attendee's token here, not
   only the organizer's. An empty result: the meeting is not one the user was invited to, or it has
   expired (Teams keeps a scheduled meeting's artifacts for a limited time after it ends).
3. `GET /me/onlineMeetings/{id}/transcripts` (`OnlineMeetingTranscript.Read.All`), then each
   transcript's `/content?$format=text/vtt`. Graph names this scope in its 403, and it is
   requested for exactly these calls, so a missing consent fails here and nowhere else.

A meeting usually has one transcript; one that was stopped and restarted has several. All are
read, oldest first, and their utterances are returned in one list with one running clock: a later
transcript's times continue from where the previous one ended, and each utterance carries
`segment` (1, 2, …) when there is more than one, so `start` means one thing for the whole meeting.

| Flag / input               | Default    | Meaning                                                                       |
| -------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `--find` / `find`          |            | Words that must all appear in an utterance; only those and their context      |
| `--context` / `context`    | 2 (max 20) | With `--find`: utterances either side of each match                           |
| `--start` / `start`        | 00:00:00   | Skip utterances before this offset into the transcript (`mm:ss` or `h:mm:ss`) |
| `--max-chars` / `maxChars` | 24000      | A ceiling on utterance text returned; `0` for no ceiling at the terminal      |

- **Utterances.** WebVTT cues carry a start time, an end time and a `<v Speaker>` voice tag.
  Consecutive cues by the same speaker are merged into one utterance, which cuts the text by half
  or more without losing a word: Teams emits a cue every few seconds. Each utterance is
  `{ at, seconds, speaker?, text }`, with `at` as `HH:MM:SS` from the transcript's start. Tags
  other than the voice tag are dropped; entities are decoded; control characters stripped, as every
  message body is.
- **Finding.** `--find` matches as 0007's chat scan does: every word must appear, case-insensitively,
  in the utterance's text. Matching utterances are marked `hit: true`; each is returned with
  `context` utterances either side, overlapping windows merged, in time order. `matched` counts the
  hits. No match returns no utterances and says so.
- **Budget.** Utterances are taken in time order from `start` until their text would exceed
  `maxChars`. The result then has `truncated: true` and `nextStart`, the `at` of the first
  utterance left out, so the next call `--start` there. With `--find` the budget applies to the
  windows. The CLI's `--max-chars 0` lifts the ceiling, for a person who wants the file.
- **Speaker attribution.** A tenant can disallow speaker attribution, in which case Graph refuses
  `text/vtt` with `SpeakerAttributionNotAllowed`. The content is then fetched again as
  `application/vnd.microsoft.graph.transcript+text`, which carries the same utterances without
  speakers, and the result says `attributed: false`. A tenant can also turn Graph access to
  transcripts off altogether (`GraphAccessToTranscriptsDisabled`); that is reported in those words,
  with "an administrator changes this in the Teams admin center", and nothing is retried.

### What comes back

```ts
interface MeetingTranscript {
  meeting: {
    ref: string; // the meeting chat's ref
    id: string; // Graph's onlineMeeting id
    subject?: string;
    startedAt?: string;
    endedAt?: string;
    organizer?: string;
    joinUrl?: string;
  };
  transcripts: Array<{ id: string; createdAt?: string }>; // oldest first
  attributed: boolean; // false when the tenant disallows speaker names
  utterances: Array<{ at: string; seconds: number; speaker?: string; text: string; segment?: number; hit?: boolean }>;
  matched?: number; // with `find`
  truncated: boolean;
  nextStart?: string; // pass as `start` to continue
  note?: string; // "No transcript: …", or why speakers are missing
}
```

The CLI prints a header (subject, when, organizer, how many transcripts, whether speakers are
named), then one line per utterance: `[00:12:03] Ada Lovelace: …`, with a `…` line between
windows under `--find`, and a final line saying where to continue when truncated. `--json`
returns the shape above. Both pass through 0005's cleaning: an utterance holding a secret is
withheld whole, personal data is placeholdered; `joinUrl` and `at` are identifiers and left alone.

### Errors

| Situation                                                          | Result                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| A chat ref that is not a meeting chat                              | `ConfigError`: that chat is not a meeting chat; `meeting list` names the ones that are                         |
| The join link is not a meeting the user was invited to, or expired | `HttpError` (404): no such meeting on this account, or it has expired                                          |
| No transcript                                                      | Success, with `utterances: []` and a `note`: transcription was off, or the transcript is still being processed |
| `OnlineMeetingTranscript.Read.All` not granted                     | `AuthError` from Graph's 403 naming the scope, as for channel reads                                            |
| Graph access to transcripts disabled for the tenant                | `AuthError` naming the tenant setting; not retried                                                             |
| A transcript that cannot be read when the meeting has several      | Skipped and counted in the `note`, like an unreadable thread in 0006                                           |

## Alternatives considered

- **List meetings from the calendar** (`/me/calendarView`, `Calendars.ReadBasic`). It would give
  start times and meetings whose chat the user never opened, but it adds a scope that reads every
  appointment's subject, for one list. The meeting chats cover what an agent is actually asked
  about: meetings the user was in. If someone needs the calendar, that is its own doc.
- **Search transcripts across meetings.** Graph does not index transcripts, so this would be a
  download of every recent transcript on each query, the 0007 scan scaled up by a thousand. `--find`
  on one meeting is the bounded version; `message context` finds the meeting chat, and the
  transcript follows. Revisit if the one-meeting form proves too narrow.
- **Return the raw WebVTT.** Half the bytes are timestamps and cue tags; an agent would spend its
  budget on them. Parsed utterances are what the question needs, and `--json` still carries the
  times.
- **Resolve a join link by the `JoinWebUrl` filter directly**, skipping the chat. The link's exact
  form varies with where it was copied from, and Graph's filter wants the form it holds. The chat's
  `onlineMeetingInfo.joinWebUrl` is that form, and the chat ID is in every link's path, so the
  chat is the reliable hop, at the cost of one `Chat.Read` call.
- **Keep transcript scopes out of `auth login`**, behind a flag as writes are (0004). Writes are
  kept apart so the read status never reports them missing and a read-only app can never post;
  reading a transcript is a read, and the admin consent it needs is the same conversation as
  `ChannelMessage.Read.All`. Two admin round trips in a government tenant could be two months.
- **Recordings** (`OnlineMeetingArtifact.Read.All`). A video is of no use to an agent; the
  transcript is the recording's text.
- **A beta endpoint** for transcripts by organizer (`getAllTranscripts`): application-only, not
  available in US Government clouds, and the wrong model (0001).

## Implementation plan

1. Core `token.ts`: `OnlineMeetings.Read` joins `USER_CONSENT_SCOPES` (satisfied by
   `OnlineMeetings.ReadWrite`), `OnlineMeetingTranscript.Read.All` joins `ADMIN_CONSENT_SCOPES`.
2. Core `http.ts`: `HttpTransport.text(call)`, the same retries, auth handling and timeout as `json`
   for a response read as text, with an `accept` on the call; `GraphClient.getText`.
3. Core `refs.ts`: a `meetup-join` link parses to the meeting chat (`kind: 'chat'`), since the
   chat ID is its first path segment.
4. Core `vtt.ts`: `parseTranscript(text)` → cues; `mergeUtterances(cues)`; the `HH:MM:SS` formatter.
5. Core `meetings.ts`: `listMeetings`, `resolveMeeting` (the three-step path), `readTranscript`
   (options `find`, `context`, `start`, `maxChars`), the error mapping, `SCOPES.meetings` and
   `SCOPES.transcripts` in `operations.ts`.
6. Core `guard-results.ts`: `joinUrl` is an identifier. `index.ts` and its pinned-export test.
7. CLI: `commands/teams/meeting/list.ts`, `meeting/transcript.ts`, `shared/meeting-output.ts`;
   the `teams:meeting` topic; `auth status` already reports the new scopes through `READ_SCOPES`.
8. MCP: `teams_meeting_list`, `teams_meeting_transcript`; the parity test picks them up.
9. Docs: this record, the index, `credentials.md` and `app-registration.md` (two rows; the IDs are
   `9be106e1-f4e3-4df5-bdff-e4bc531cbe43` and `30b87d18-ebb1-45db-97f8-82ccb1f0190c`), the MCP
   guide, the READMEs, AGENTS.md.

## Testing

- **core/vtt**: a cue with a voice tag, without one, with inner tags and entities; consecutive cues
  by one speaker merge, a speaker change does not; a malformed line is skipped, not fatal; times
  format as `HH:MM:SS`.
- **core/meetings** (local server): a chat without `onlineMeetingInfo` is refused before any
  meeting call; the filter is sent with the chat's `joinWebUrl`, encoded; an empty filter result is
  a 404 with the expiry wording; each call names only its scope; two transcripts come back oldest
  first with `segment`; `find` + `context` windows merge and mark hits; `start` skips; the budget
  sets `truncated` and `nextStart`; `SpeakerAttributionNotAllowed` fetches the unattributed form
  once and sets `attributed: false`; `GraphAccessToTranscriptsDisabled` is not retried; a
  `meetup-join` link and a chat ref resolve to the same chat.
- **core/http**: `text()` returns the body untouched, retries a 429, refreshes once on 401.
- **CLI** (nock): `meeting list` prints only meeting chats; `meeting transcript` prints the header
  and utterance lines, and `--json` the shape; `--max-chars 0` prints everything.
- **MCP**: the two tools reach core with their inputs; a secret in an utterance is withheld in the
  result.

## Open questions

- **Whether `/me/chats` includes `onlineMeetingInfo`** in its list page, or only `GET /chats/{id}`
  does. The implementation reads it from the list when present and from the chat otherwise, and
  the first live run settles which; `meeting list` would cost one extra call per meeting in the
  second case.
- **The unattributed format's exact shape.** Documented as "timestamped utterances without speaker
  information", in force since July 2026. The parser treats it as WebVTT without voice tags; if it
  differs, the first tenant that disallows attribution will show how.
- **Meeting expiry.** How long after a meeting Graph still serves its transcript depends on
  Teams' meeting expiration rules; the error wording says "expired" without a number for that
  reason. Owner: whoever first hits it in a real tenant.
