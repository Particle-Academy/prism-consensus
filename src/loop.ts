/**
 * The autonomous discussion: rounds until the human says stop.
 *
 * Go starts it. Stop ends it. **Nothing else stops it** — not consensus being
 * reached, not every agent having voted, not a round producing no change. That
 * is the instruction, and it is worth stating plainly because the opposite is
 * the obvious engineering choice and would be wrong here: a room that halted
 * itself on first agreement would hide exactly the thing this app is for, which
 * is whether agreement SURVIVES more discussion.
 *
 * ## What this spends
 *
 * Every round is one real turn per agent, on the human's subscription. An
 * unbounded loop spending real money is a serious thing to build, so the cost
 * is made VISIBLE rather than capped behind the human's back: the round number
 * and the running state stream to the UI on every change. Capping it silently
 * would be deciding on their behalf while letting the button claim otherwise.
 *
 * Two bounds are kept anyway, and neither is a disguised stop:
 *
 * - **A pause between rounds.** Not a throttle for its own sake — it is what
 *   makes Stop land within a second or two rather than at the mercy of a turn,
 *   and it keeps a room that is failing fast from becoming a tight loop of paid
 *   requests.
 * - **Backoff after a round where every agent failed.** A room whose agents all
 *   error would otherwise spin, and spinning on failure is not discussion. It
 *   keeps trying — it just stops hammering.
 */
import { runRound, type AgentSeat, type TurnResult } from './agents.js';
import type { Room } from './room.js';

export interface LoopState {
  readonly running: boolean;
  /** True from the moment Stop is pressed until the loop has actually ended. */
  readonly stopping: boolean;
  /** Rounds completed since Go. */
  readonly round: number;
  /** Null unless the last round failed for every agent. */
  readonly lastError: string | null;
}

export interface LoopOptions {
  /** Pause between rounds. Short, so Stop is responsive. */
  readonly pauseMs?: number;
  /** Pause after a round in which every agent failed. */
  readonly backoffMs?: number;
  /** Called whenever the state a client can see has changed. */
  readonly onChange?: () => void;
  /** Called after each round, for logging. */
  readonly onRound?: (round: number, results: readonly TurnResult[]) => void;
}

export class DiscussionLoop {
  readonly #room: Room;
  readonly #seats: readonly AgentSeat[];
  readonly #options: LoopOptions;

  #controller: AbortController | null = null;
  #stopping = false;
  #round = 0;
  #lastError: string | null = null;
  /** The in-flight loop, so stop() can await a clean end. */
  #ran: Promise<void> | null = null;

  constructor(room: Room, seats: readonly AgentSeat[], options: LoopOptions = {}) {
    this.#room = room;
    this.#seats = seats;
    this.#options = options;
  }

  get state(): LoopState {
    return {
      running: this.#controller !== null,
      stopping: this.#stopping,
      round: this.#round,
      lastError: this.#lastError,
    };
  }

  /**
   * Start discussing.
   *
   * Idempotent: pressing Go twice does not start two loops, which would double
   * every agent's turns and the bill with them.
   */
  start(): void {
    if (this.#controller !== null) return;
    if (this.#seats.length === 0) throw new Error('add an agent before starting');
    if (this.#room.question === null) throw new Error('seed the question before starting');

    this.#controller = new AbortController();
    this.#stopping = false;
    this.#round = 0;
    this.#lastError = null;
    this.#options.onChange?.();

    this.#ran = this.#run(this.#controller.signal).finally(() => {
      this.#controller = null;
      this.#stopping = false;
      this.#options.onChange?.();
    });
  }

  /**
   * Stop discussing, and wait until it has actually stopped.
   *
   * Aborts the in-flight round rather than letting it drain. On a room of
   * several agents, draining is tens of seconds of paid work after the human
   * asked for it to end — and a Stop button that takes half a minute to do
   * anything reads as a broken button, which invites a second press.
   *
   * An aborted turn records nothing, so the room is never left holding half a
   * contribution.
   */
  async stop(): Promise<void> {
    if (this.#controller === null) return;
    this.#stopping = true;
    this.#options.onChange?.();
    this.#controller.abort();
    await this.#ran;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const results = await runRound(this.#room, this.#seats, signal);

      // A round aborted mid-flight is not a round. Counting it would make the
      // round number claim work that was cancelled.
      if (signal.aborted) break;

      this.#round += 1;
      const failed = results.filter((r) => r.error !== null);
      this.#lastError =
        failed.length === results.length && results.length > 0
          ? (failed[0]?.error ?? 'every agent failed')
          : null;

      this.#options.onRound?.(this.#round, results);
      this.#options.onChange?.();

      // Backoff only when EVERY agent failed. One failing agent among several
      // is a normal round -- the others still spoke, and slowing the room down
      // for it would punish the participants that worked.
      await sleep(this.#lastError === null
        ? (this.#options.pauseMs ?? 1500)
        : (this.#options.backoffMs ?? 15_000), signal);
    }
  }
}

/** Sleep, but wake immediately on abort so Stop is not waiting out a pause. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
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
