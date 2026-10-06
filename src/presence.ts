/**
 * One independent loop per agent. No rounds.
 *
 * The previous design ran synchronised rounds — every agent spoke, everyone
 * waited, repeat — and that was wrong in a way a chat room makes obvious: a
 * room where everyone speaks exactly once in a fixed order is a meeting with
 * minutes, not a conversation. So each agent now watches the room and decides
 * for itself when to speak.
 *
 * Nothing coordinates them. There is no scheduler, no turn, and no round
 * counter. What they share is the room, and three facts they each observe:
 *
 * ## 1. The quiet period
 *
 * An agent will not start speaking until **two seconds** have passed since the
 * last message was committed. That is the buffer Wish asked for, and it is
 * measured from the POST, not from a tick: new traffic during the wait pushes
 * the deadline out, so an agent always replies to a settled room rather than
 * interrupting somebody mid-thought.
 *
 * It also stops the loops from re-synchronising by accident. A fixed sleep
 * would have every agent wake together two seconds after a message and all
 * speak at once — rounds again, arrived at sideways.
 *
 * ## 2. The floor
 *
 * One speaker at a time. Not borrowed from rounds: several agents streaming at
 * once produces interleaved half-sentences nobody can read, and agents that
 * cannot read each other stop discussing and start talking past one another.
 * Each agent observes the floor and waits — it is a fact, not a turn handed to
 * it.
 *
 * ## 3. Something new to answer
 *
 * An agent speaks only when the room has moved since it last spoke. Otherwise
 * two agents with nothing to add would fill the transcript with restatements,
 * burning the human's subscription to say nothing.
 *
 * ## Jitter, and why it is not decoration
 *
 * Each agent waits a small random extra interval before reaching for the floor.
 * Without it, two agents whose quiet periods expire in the same millisecond
 * race for it every single time, and the same one wins — so one agent would
 * dominate the room for a reason that has nothing to do with what it had to
 * say.
 */
import type { AgentSeat } from './agents.js';
import { parseVote, withoutVoteLine } from './conversation.js';
import { Principal, type Room } from './room.js';

/** Two seconds, as asked. Measured from the last committed message. */
export const QUIET_MS = 2000;

export interface PresenceOptions {
  readonly quietMs?: number;
  /** Upper bound on the random wait before reaching for the floor. */
  readonly jitterMs?: number;
  /** How often an idle agent re-checks the room. */
  readonly pollMs?: number;
  readonly onChange?: () => void;
  /** Called as text streams in, so a surface can render it live. */
  readonly onChunk?: (participantId: string) => void;
  readonly onError?: (participantId: string, problem: string) => void;
  /**
   * One message committed.
   *
   * Carries the CLI session id so a caller can persist it -- the id only exists
   * after a turn has run, and it is what `--resume` needs next time. Without
   * somewhere durable to put it, a restarted room silently starts every agent
   * over.
   */
  readonly onSpoke?: (participantId: string, cliSessionId: string | null, spoke: number) => void;
}

export interface PresenceState {
  readonly participantId: string;
  readonly running: boolean;
  /** `waiting` | `speaking` — what a reader would see it doing. */
  readonly doing: 'waiting' | 'speaking';
  readonly spoke: number;
  readonly lastError: string | null;
}

/** One agent, living in the room on its own. */
export class AgentPresence {
  readonly #seat: AgentSeat;
  readonly #room: Room;
  readonly #options: PresenceOptions;

  #controller: AbortController | null = null;
  #ran: Promise<void> | null = null;
  #doing: PresenceState['doing'] = 'waiting';
  #spoke = 0;
  #lastError: string | null = null;
  /** The room's message count when this agent last spoke. */
  #seen = -1;

  constructor(seat: AgentSeat, room: Room, options: PresenceOptions = {}) {
    this.#seat = seat;
    this.#room = room;
    this.#options = options;
  }

  get participantId(): string {
    return this.#seat.participant.id;
  }

  get state(): PresenceState {
    return {
      participantId: this.participantId,
      running: this.#controller !== null,
      doing: this.#doing,
      spoke: this.#spoke,
      lastError: this.#lastError,
    };
  }

  start(): void {
    if (this.#controller !== null) return;
    this.#controller = new AbortController();
    this.#ran = this.#live(this.#controller.signal).finally(() => {
      this.#controller = null;
      this.#doing = 'waiting';
      this.#options.onChange?.();
    });
  }

  async stop(): Promise<void> {
    if (this.#controller === null) return;
    this.#controller.abort();
    await this.#ran;
    // Release the floor on the way out, or a stopped agent would hold it
    // forever and the room would look permanently busy.
    this.#room.abandonSpeech(this.#principal());
    this.#options.onChange?.();
  }

  #principal(): Principal {
    return Principal.authenticated(this.#seat.participant.id, 'agent');
  }

  async #live(signal: AbortSignal): Promise<void> {
    const quiet = this.#options.quietMs ?? QUIET_MS;
    const jitter = this.#options.jitterMs ?? 600;
    const poll = this.#options.pollMs ?? 250;

    while (!signal.aborted) {
      await sleep(poll, signal);
      if (signal.aborted) return;

      // Nothing new since I last spoke: say nothing. Two agents restating
      // themselves would burn the human's subscription to add no information.
      if (this.#room.messages.length <= this.#seen) continue;
      if (this.#room.question === null) continue;

      // The quiet period, measured from the last POST so that new traffic
      // pushes it out rather than letting an agent interrupt.
      const since = Date.now() - this.#room.lastPostedAt;
      if (since < quiet) continue;

      // Somebody else is mid-sentence.
      if (this.#room.floorHeldBy !== null) continue;

      await sleep(Math.random() * jitter, signal);
      if (signal.aborted) return;
      // Re-check after the jitter: another agent may have taken the floor or
      // posted during it, and acting on a stale observation is how two agents
      // end up speaking together.
      if (this.#room.floorHeldBy !== null) continue;
      if (Date.now() - this.#room.lastPostedAt < quiet) continue;

      await this.#speak(signal);
    }
  }

  async #speak(signal: AbortSignal): Promise<void> {
    const me = this.#principal();

    try {
      this.#room.beginSpeaking(me);
    } catch {
      // Lost the race for the floor. Not an error -- somebody else got there
      // first, which is what the floor is for.
      return;
    }

    this.#doing = 'speaking';
    this.#seen = this.#room.messages.length;
    this.#options.onChange?.();

    try {
      const result = await this.#seat.takeTurn(this.#room, signal, (text) => {
        // Streamed straight into the room, which is what makes the chat live:
        // the surface renders a message that is still being written.
        this.#room.appendSpeech(me, text);
        this.#options.onChunk?.(this.participantId);
      });

      if (signal.aborted || result.error !== null) {
        this.#room.abandonSpeech(me);
        if (result.error !== null && !signal.aborted) {
          this.#lastError = result.error;
          this.#options.onError?.(this.participantId, result.error);
        }
        return;
      }

      // Committed in one step, with the vote line stripped: the transcript
      // should read as speech rather than as a tally. Abandoning and re-posting
      // would make the message visibly vanish and reappear in a surface that is
      // watching it being written.
      const spoken = this.#room.live?.text ?? '';
      this.#room.finishSpeaking(me, withoutVoteLine(spoken));

      if (result.thought.trim().length > 0) {
        this.#room.beginSpeaking(me, 'thought');
        this.#room.appendSpeech(me, result.thought);
        this.#room.finishSpeaking(me);
      }

      const vote = parseVote(spoken);
      if (vote !== null) this.#room.castVote(me, vote.choice, vote.reason);

      this.#spoke += 1;
      this.#lastError = null;
      this.#options.onSpoke?.(this.participantId, this.#seat.resumesFrom, this.#spoke);
    } catch (cause) {
      this.#room.abandonSpeech(me);
      this.#lastError = cause instanceof Error ? cause.message : String(cause);
      this.#options.onError?.(this.participantId, this.#lastError);
    } finally {
      this.#doing = 'waiting';
      // `seen` is advanced to NOW rather than to where it was when this turn
      // began, so an agent does not immediately answer its own message.
      this.#seen = this.#room.messages.length;
      this.#options.onChange?.();
    }
  }
}

/** Every agent in the room, living independently. */
export class Presences {
  readonly #all: AgentPresence[];

  constructor(presences: AgentPresence[]) {
    this.#all = presences;
  }

  get states(): readonly PresenceState[] {
    return this.#all.map((p) => p.state);
  }

  get running(): boolean {
    return this.#all.some((p) => p.state.running);
  }

  start(): void {
    for (const presence of this.#all) presence.start();
  }

  /** Stop all of them, and do not return until every one has stopped. */
  async stop(): Promise<void> {
    await Promise.all(this.#all.map(async (presence) => await presence.stop()));
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
