/**
 * One seat per agent, each owning its own session.
 *
 * This is where the app dogfoods `prism-acp`: it imports the transport directly
 * and drives a real agent CLI, exactly as a third-party consumer would. There
 * is no bridge, no sidecar and no adapter — if the transport is awkward to use,
 * that shows up here first, which is the point of a testbed.
 *
 * ## Several seats, genuinely concurrent
 *
 * A room holds several agents and they take their turns in parallel, each with
 * its own child process and its own in-flight turn. That was recorded as a
 * TRANSPORT requirement before either side existed, and it is why `prism-acp`
 * holds sessions in a map rather than assuming one: a design that worked for
 * the first agent would have had to be taken apart for the second.
 *
 * ## A seat remembers its conversation
 *
 * Each seat keeps the CLI's own session id and RESUMES on later turns, so an
 * agent in round three remembers round one without being re-fed the whole
 * transcript. That also dogfoods the resume this transport proves separately —
 * if resume quietly started a fresh conversation, an agent here would start
 * contradicting itself, which is a far more visible failure than a flag.
 *
 * The CLI's session id is deliberately NOT the participant id. `--resume` wants
 * the CLI's, and conflating the two is how a resume silently starts over.
 */
import { ClaudeDriver, type AcpUpdate } from '@particle-academy/prism-acp';
import { parseVote, promptFor, withoutVoteLine, type ParsedVote } from './conversation.js';
import { Principal, type Participant, type Room } from './room.js';

export interface TurnResult {
  readonly participantId: string;
  /** What the agent said, with its vote line removed. */
  readonly text: string;
  /** Its reasoning, if the CLI reported any. Shown to the human, not to agents. */
  readonly thought: string;
  readonly vote: ParsedVote | null;
  /** Non-null when the turn failed; the seat is then skipped, not counted. */
  readonly error: string | null;
}

export interface SeatOptions {
  readonly cwd: string;
  /** Overridable so tests can drive something other than the real CLI. */
  readonly driverFactory?: DriverFactory;
}

export type DriverFactory = (options: {
  cwd: string;
  resumeSessionId?: string;
}) => SeatDriver;

/** The slice of a driver a seat needs. */
export interface SeatDriver {
  start(): void;
  prompt(text: string): void;
  endInput(): void;
  readonly cliSessionId: string | null;
  on(events: {
    onUpdate: (update: AcpUpdate) => void;
    onExit: (code: number | null) => void;
  }): void;
}

export class AgentSeat {
  readonly participant: Participant;
  readonly #options: SeatOptions;
  /** The CLI's session id, for resuming. Null until the first turn reports one. */
  #cliSessionId: string | null = null;

  constructor(participant: Participant, options: SeatOptions) {
    this.participant = participant;
    this.#options = options;
  }

  get resumesFrom(): string | null {
    return this.#cliSessionId;
  }

  /** Run one turn: prompt, collect, parse. Records nothing — see {@link applyTurn}. */
  async takeTurn(room: Room): Promise<TurnResult> {
    const prompt = promptFor(room, this.participant);
    const said: string[] = [];
    const thought: string[] = [];

    const factory = this.#options.driverFactory ?? realDriver;
    const driver = factory({
      cwd: this.#options.cwd,
      ...(this.#cliSessionId === null ? {} : { resumeSessionId: this.#cliSessionId }),
    });

    const code = await new Promise<number | null>((resolve) => {
      driver.on({
        onUpdate: (update) => {
          if (update.sessionUpdate === 'agent_message_chunk') {
            said.push(textOf(update));
          } else if (update.sessionUpdate === 'agent_thought_chunk') {
            thought.push(textOf(update));
          }
        },
        onExit: resolve,
      });
      driver.start();
      driver.prompt(prompt);
      driver.endInput();
    });

    // Captured after the turn: the id arrives in the CLI's init frame, so it is
    // only known once something has been read.
    this.#cliSessionId = driver.cliSessionId ?? this.#cliSessionId;

    const reply = said.join('');
    if (code !== 0) {
      // A failed turn produces NO vote. Counting a crashed agent as having
      // agreed would be the worst possible default in a consensus room; it
      // stays outstanding, which is true.
      return {
        participantId: this.participant.id,
        text: '',
        thought: thought.join(''),
        vote: null,
        error: `agent exited with code ${String(code)}`,
      };
    }

    return {
      participantId: this.participant.id,
      text: withoutVoteLine(reply),
      thought: thought.join(''),
      vote: parseVote(reply),
      error: null,
    };
  }
}

/**
 * Write a turn into the room.
 *
 * Separate from taking the turn so the attribution is visible in one place: the
 * Principal is minted HERE, from the seat the turn came from, and the agent's
 * own text has no say in it. An agent that writes a participant id into its
 * reply has written some words.
 */
export function applyTurn(room: Room, seat: AgentSeat, result: TurnResult): void {
  const principal = Principal.authenticated(seat.participant.id, 'agent');

  if (result.error !== null) return;
  if (result.text.length > 0) room.say(principal, result.text);
  if (result.thought.length > 0) room.say(principal, result.thought, 'thought');
  if (result.vote !== null) room.castVote(principal, result.vote.choice, result.vote.reason);
}

/** Run every seat's turn at once, which is the concurrency the room needs. */
export async function runRound(
  room: Room,
  seats: readonly AgentSeat[],
): Promise<readonly TurnResult[]> {
  // allSettled, not all: one agent failing must not cost the round. A rejected
  // promise here would discard the turns that succeeded alongside it.
  const settled = await Promise.allSettled(seats.map(async (seat) => await seat.takeTurn(room)));

  const results: TurnResult[] = [];
  for (const [index, outcome] of settled.entries()) {
    const seat = seats[index]!;
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
      applyTurn(room, seat, outcome.value);
    } else {
      results.push({
        participantId: seat.participant.id,
        text: '',
        thought: '',
        vote: null,
        error: String(outcome.reason),
      });
    }
  }
  return results;
}

function textOf(update: AcpUpdate): string {
  const content = update.content as { text?: string } | undefined;
  return content?.text ?? '';
}

/** The real thing: a `prism-acp` driver over the user's own authenticated CLI. */
function realDriver(options: { cwd: string; resumeSessionId?: string }): SeatDriver {
  let driver: ClaudeDriver | null = null;

  return {
    on(events) {
      driver = new ClaudeDriver(
        {
          cwd: options.cwd,
          permissionMode: 'dontAsk',
          // A participant in a discussion needs no tools, and an agent that
          // could run commands in a room the human is watching is a different
          // product with a different threat model.
          disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Task'],
          ...(options.resumeSessionId === undefined
            ? {}
            : { resumeSessionId: options.resumeSessionId }),
        },
        {
          onUpdate: events.onUpdate,
          // Annotated rather than inferred. It was inferred, until a CI run
          // could not resolve the module and reported an implicit `any` here as
          // a SECOND error -- noise that looked like a separate defect while
          // being a symptom of the first. An explicit type is correct either
          // way and keeps one cause producing one error.
          onExit: (code: number | null) => events.onExit(code),
        },
      );
    },
    start() {
      driver?.start();
    },
    prompt(text) {
      driver?.prompt(text);
    },
    endInput() {
      driver?.endInput();
    },
    get cliSessionId() {
      return driver?.cliSessionId ?? null;
    },
  };
}
