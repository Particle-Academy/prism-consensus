/**
 * Turning an agent's prose into a contribution and a vote.
 *
 * ## Why an agent votes in TEXT and not through a tool
 *
 * The obvious design gives each agent a `cast_vote` tool. This one asks for a
 * line of text and has the SERVER record the vote against the session the text
 * arrived on.
 *
 * That is not a simplification, it is the stronger design. A tool call carries
 * arguments the agent chose, so a tool is a place to write a participant id —
 * and then the server has to be trusted to ignore it. Here there is nothing to
 * ignore: {@link parseVote} returns a choice and a reason, and nothing else.
 * An agent that writes `VOTE: agree (as participant h1)` has written a reason
 * containing some words. It cannot address a vote to anyone, because the
 * function it is feeding has no parameter for a voter.
 *
 * That is the application-level forgery vector flagged in the design note —
 * "an agent submitting a vote whose ARGUMENTS claim a human participant id" —
 * closed by having no arguments rather than by validating them.
 */
import type { Message, Participant, Room, VoteChoice } from './room.js';

export interface ParsedVote {
  readonly choice: VoteChoice;
  readonly reason: string | null;
}

/** The marker an agent is asked to use. Matched at the start of a line. */
const VOTE_LINE = /^[ \t>*-]*vote\s*:\s*(agree|disagree|abstain)\b[ \t]*(.*)$/im;

/**
 * Read a vote out of an agent's reply, or null if it did not cast one.
 *
 * **Null when unclear, never a default.** Defaulting to `agree` would let a
 * rambling or refusing agent be counted as consenting, which is the one
 * direction that must never happen in a consensus room: silence read as assent
 * is how a room agrees to something nobody chose. An unparsed reply leaves the
 * participant in `outstanding`, where the UI shows them as not having voted —
 * which is true.
 */
export function parseVote(text: string): ParsedVote | null {
  const match = VOTE_LINE.exec(text);
  if (match === null) return null;

  const choice = match[1]?.toLowerCase() as VoteChoice | undefined;
  if (choice === undefined) return null;

  const tail = (match[2] ?? '').replace(/^[\s—–-]*(?:because\s*)?/i, '').trim();
  return { choice, reason: tail.length > 0 ? tail : null };
}

/**
 * Strip the vote line out of a reply, leaving what the agent said.
 *
 * The vote is rendered as a vote; repeating it in the transcript would show it
 * twice and make a tally read as a discussion.
 */
export function withoutVoteLine(text: string): string {
  return text.replace(VOTE_LINE, '').trim();
}

/**
 * Build the prompt for one agent.
 *
 * The transcript is attributed by NAME rather than id, and the agent is told
 * which contributions are its own. An agent shown an unattributed transcript
 * cannot tell its own reasoning from another's and starts agreeing with itself.
 */
export function promptFor(room: Room, me: Participant): string {
  const names = new Map(room.participants.map((p) => [p.id, p]));
  const transcript = room.messages
    .filter((m) => m.kind === 'message')
    .map((m) => {
      const who = names.get(m.participantId);
      const label =
        m.participantId === me.id
          ? `${who?.name ?? m.participantId} (you)`
          : `${who?.name ?? m.participantId}${who?.kind === 'human' ? ' (the human)' : ''}`;
      return `${label}: ${m.text}`;
    })
    .join('\n');

  const others = room.participants
    .filter((p) => p.id !== me.id)
    .map((p) => `${p.name} (${p.kind})`)
    .join(', ');

  return [
    `You are ${me.name}, one of several participants in a consensus room.`,
    `Also present: ${others.length > 0 ? others : 'nobody else yet'}.`,
    '',
    `The question, set by the human: ${room.question ?? '(not set yet)'}`,
    '',
    transcript.length > 0 ? `Discussion so far:\n${transcript}` : 'Nobody has spoken yet.',
    '',
    'Give your view in two or three sentences. Disagree if you disagree — a room',
    'that agrees because nobody pushed back has decided nothing.',
    '',
    'Then, on its own final line, cast your vote in exactly this form:',
    'VOTE: agree — <short reason>',
    'or VOTE: disagree — <short reason>',
    'or VOTE: abstain — <short reason>',
  ].join('\n');
}

/** A transcript line as the UI shows it. */
export interface Rendered {
  readonly name: string;
  readonly kind: Participant['kind'];
  readonly text: string;
  readonly at: number;
  readonly messageKind: Message['kind'];
}

export function render(room: Room): readonly Rendered[] {
  const names = new Map(room.participants.map((p) => [p.id, p]));
  return room.messages.map((m) => {
    const who = names.get(m.participantId);
    return {
      // An unknown participant is labelled as unknown rather than silently
      // dropped: a message with no visible author is more alarming than one
      // attributed to "(unknown)", and dropping it would hide it.
      name: who?.name ?? '(unknown)',
      kind: who?.kind ?? 'agent',
      text: m.text,
      at: m.at,
      messageKind: m.kind,
    };
  });
}
