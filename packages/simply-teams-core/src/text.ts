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
 * Removes anything from server-chosen text that could make the rendered output lie.
 *
 * Anyone able to file a ticket controls an issue summary, anyone with page-edit rights controls
 * a page body, and anyone with an account controls their display name. Three classes of
 * character therefore have to go.
 *
 * ESC, BEL, backspace and the C1 range can erase or overwrite lines already printed, so a table
 * could show a different status or assignee than the API actually returned.
 *
 * A bare carriage return does the same thing with no escape sequence at all: everything before
 * it is overwritten on screen but still reaches a caller reading the stream. That splits what a
 * person reviewing the terminal sees from what an agent actually ingests, which is precisely the
 * human-in-the-loop check this output exists to support.
 *
 * Invisible Unicode format and bidi characters can reorder or hide text visually while leaving
 * the underlying bytes intact.
 *
 * Newline and tab are kept: they carry the layout this renderer emits.
 */
/** Characters that can erase or overwrite text already printed. */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire point
const REWRITES_THE_SCREEN = /[\u0000-\u0008\u000B-\u000D\u000E-\u001F\u007F-\u009F]/g;

/**
 * Invisible formatting and bidi characters, which reorder or hide text while leaving the bytes
 * intact. U+2028/U+2029 are line separators that several terminals and JSON consumers treat as
 * newlines, so they forge a break that `\n` handling would otherwise have caught.
 */
const HIDES_OR_REORDERS = /[\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Invisible characters that carry text rather than merely hiding it.
 *
 * The tag block is the canonical ASCII-smuggling vector: `Done` plus a tag-encoded instruction
 * renders as `Done` to a person and reaches a tokenizer in full, which defeats the alignment
 * this whole module exists to keep. The Hangul fillers are the same trick for a display name
 * that renders blank; variation selectors carry payload the same way.
 *
 * Held in a named constant rather than inlined because the disable below has to sit immediately
 * above the pattern, and prettier reformats a long inline `.replaceAll(...)` across lines —
 * which silently moved the directive off its target once already.
 */
/*
 * A block disable, not `eslint-disable-next-line`: variation selectors are combining marks by
 * definition so the rule fires, and stripping them individually is precisely the intent — but
 * prettier reflows this assignment across lines, which silently moved a line-scoped directive
 * off its target twice. A block cannot drift.
 */
/* eslint-disable no-misleading-character-class */
const SMUGGLES_TEXT =
  /[\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u115F\u1160\u180B-\u180E\u3164\uFFA0]/gu;
/* eslint-enable no-misleading-character-class */

export function stripControl(text: string): string {
  return text.replaceAll(REWRITES_THE_SCREEN, '').replaceAll(HIDES_OR_REORDERS, '').replaceAll(SMUGGLES_TEXT, '');
}

/**
 * Collapses server text onto a single line, for contexts where a newline is itself the attack.
 *
 * `stripControl` keeps `\n` because the layout this module emits depends on it. In an error
 * message that is the wrong trade: a link type name or issue summary containing a newline can
 * forge extra stderr lines — including a line that mimics this CLI's own JSON error object —
 * and an agent parsing stderr line-by-line has no way to tell the forgery from the real thing.
 */
export function stripControlOneLine(text: string): string {
  return stripControl(text).replaceAll(/\s+/g, ' ').trim();
}
