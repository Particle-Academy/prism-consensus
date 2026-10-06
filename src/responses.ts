/**
 * The human's six responses. There are no others.
 *
 * The human does not type a vote or a reason — they pick one of these. That is
 * a product decision and also a security one:
 *
 * - **A closed set cannot be injected.** Every other string in this app that
 *   reaches an agent's prompt is untrusted and has to be treated as such. These
 *   six are not strings from a request at all: a request names a KEY, and the
 *   text an agent eventually sees is this table's, written here.
 * - **A closed set cannot be ambiguous.** "Reject" with free-text reasoning
 *   leaves an agent to interpret prose in order to act on it. `Too long` is
 *   three unmistakable options wide.
 *
 * The rejection reasons are deliberately about the PROPOSAL rather than the
 * participants — too long, not clear, wrong direction — because a room of
 * agents can act on all three and cannot act on "no".
 */
import type { VoteChoice } from './room.js';

export interface HumanResponse {
  /** What this means for the tally. */
  readonly choice: VoteChoice;
  /** Shown in the room, and the only reason text a human vote ever carries. */
  readonly reason: string;
  /** The button label. */
  readonly label: string;
}

/**
 * Keyed by a stable identifier, because the key travels over HTTP and the label
 * is for a person. Renaming a button must not change the wire.
 */
export const HUMAN_RESPONSES: Readonly<Record<string, HumanResponse>> = {
  accept: { choice: 'agree', reason: 'Accept', label: 'Accept' },

  'reject-too-long': {
    choice: 'disagree',
    reason: 'Too long',
    label: 'Reject: Too Long',
  },
  'reject-not-clear': {
    choice: 'disagree',
    reason: 'Not clear',
    label: 'Reject: Not Clear',
  },
  'reject-wrong-direction': {
    choice: 'disagree',
    reason: 'Wrong direction',
    label: 'Reject: Wrong Direction',
  },

  // Both passes remove the human's third and renormalise the agents to the
  // whole vote -- they differ in what they TELL the room, which is worth
  // keeping: "you decide" and "I don't care" lead a discussion somewhere
  // different even though the arithmetic is identical.
  'pass-agents-decide': {
    choice: 'pass',
    reason: 'Agents decide',
    label: 'Pass: Agents Decide',
  },
  'pass-not-interested': {
    choice: 'pass',
    reason: 'Not interested',
    label: 'Pass: Not Interested',
  },
};

/** The keys, in the order a surface should offer them. */
export const RESPONSE_KEYS = Object.keys(HUMAN_RESPONSES);

/**
 * Resolve a response key, or null if it is not one of the six.
 *
 * Null rather than a default. Defaulting an unrecognised key to `accept` would
 * turn a typo into agreement, and a malformed request must never become a vote
 * in favour of anything.
 */
export function humanResponse(key: unknown): HumanResponse | null {
  if (typeof key !== 'string') return null;
  return Object.hasOwn(HUMAN_RESPONSES, key) ? (HUMAN_RESPONSES[key] ?? null) : null;
}
