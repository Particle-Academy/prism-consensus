/**
 * Participant names, which turn out to be an attribution surface.
 *
 * A name reaches two places that matter: the page, and **the prompt every other
 * agent reads**. The second is the dangerous one. The transcript used to be
 * labelled
 *
 *     `${name}${kind === 'human' ? ' (the human)' : ''}`
 *
 * so an agent named literally `Wish (the human)` produced a line
 * **byte-identical** to the real human's. Every other agent then deliberated
 * believing the human had said something they had not — a worse forgery than
 * casting the human's vote, because it steers the vote rather than replacing
 * it.
 *
 * Two changes close it, and they are different kinds of fix:
 *
 * 1. **The role goes first**, in `conversation.ts`, where a name cannot reach
 *    it. A trailing marker can be imitated by a name ending in the same text; a
 *    leading one states the fact before the untrusted part begins.
 * 2. **Confusable names are refused**, here. Role-first labelling stops a name
 *    claiming to be the human, but two participants a reader cannot tell apart
 *    still make the transcript ambiguous about who said what.
 *
 * The comparison is deliberately aggressive, for the reason G-36 gives: that
 * reservation fell to a single trailing space, and the narrow fix would have
 * closed the ASCII hole and opened three Unicode ones. So names are folded to a
 * canonical form before being compared, and two names with the same canonical
 * form cannot both be in a room.
 */

/**
 * Characters that are invisible or change nothing a reader can see.
 *
 * Spelled as an explicit codepoint set rather than a Unicode property escape,
 * the same way `prism-human-plus` does, so the PHP and Python ports can match
 * it exactly. A `\p{Cf}` class is convenient and is not the same set in three
 * languages.
 */
const INVISIBLE =
  /[\u0000-\u001F\u007F­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ︀-️﻿ﾠ￹-￻]/g;

/**
 * Glyphs that read as a Latin letter and are not one.
 *
 * Not exhaustive — a complete confusables table is large and lives in Unicode's
 * own data. This covers the Cyrillic and Greek letters that look identical in
 * every common font, which is what an attacker reaches for first. It is a
 * mitigation, and saying so is better than implying a guarantee: a determined
 * homoglyph still exists, and what this buys is that the obvious ones fail.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'у': 'y', 'х': 'x', 'і': 'i', 'А': 'A', 'В': 'B',
  'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
  // Greek
  'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'Α': 'A',
  'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
  'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X',
  // Fullwidth Latin, which renders wide but reads the same
  'ａ': 'a', 'ｅ': 'e', 'ｉ': 'i', 'ｏ': 'o', 'ｕ': 'u',
};

/** Spaces that are not U+0020 and read as one. */
const WIDE_SPACE = /[   -   　]/g;

/** Maximum rendered length. Long enough for a name, short enough not to be a paragraph. */
export const MAX_NAME = 60;

/**
 * Clean a supplied name for display and for prompts.
 *
 * Invisibles are REMOVED rather than rejected, because a name is cosmetic and
 * refusing one over a stray character the user cannot see would be baffling.
 * What must not happen is the invisible surviving into a transcript, where it
 * makes two names identical to a reader and different to `===`.
 */
export function sanitiseName(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw
    .replace(INVISIBLE, '')
    .replace(WIDE_SPACE, ' ')
    .trim()
    .slice(0, MAX_NAME);

  // A name of nothing but invisibles would render as blank and attribute
  // messages to an empty label, which reads as the transcript being broken.
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The form two names are compared in.
 *
 * Case-folded, invisibles removed, confusables mapped to their Latin
 * look-alike, whitespace collapsed. Two names with the same canonical form are
 * indistinguishable to a reader, which is the only question that matters here.
 */
export function canonicalName(name: string): string {
  const folded = name
    .replace(INVISIBLE, '')
    .replace(WIDE_SPACE, ' ')
    .split('')
    .map((char) => CONFUSABLES[char] ?? char)
    .join('');

  return folded.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when a reader could not reliably tell these two names apart. */
export function confusable(left: string, right: string): boolean {
  return canonicalName(left) === canonicalName(right);
}
