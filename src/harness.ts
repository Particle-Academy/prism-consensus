/**
 * Per-agent session state, held by `prism-harness`.
 *
 * Each agent in a room gets a harness `Session` keyed on **participant +
 * scope** — the agent's id and the room's id. That is what the harness is for,
 * and it is the right shape here for the reason its own design note gives: a
 * session is durable state with a reconstructed runtime, not a live object. An
 * agent's loop can be stopped, the process can exit, and what the agent knows
 * about its own conversation survives.
 *
 * Two things are kept, and both are things this app got wrong without it:
 *
 * - **`cliSessionId`** — the agent CLI's own session id, which `--resume` wants.
 *   Held in memory before, so a restart made every agent start a fresh
 *   conversation while the transcript implied continuity. A resume that
 *   silently starts over does not error; it just produces an agent that
 *   contradicts itself.
 * - **`spoke`** — how many times this agent has spoken. Small, but it is the
 *   difference between "this agent has nothing to add" and "this agent has
 *   never been asked".
 *
 * ## Why `usingCapability` rather than a table of our own
 *
 * The harness offers a durable keyed store per session, and reaching past it
 * for a `Map` would mean this app had a second notion of session state that
 * agrees with the harness by luck. The point of a testbed is to use the thing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionStore,
  MemorySessionStore,
  Session,
  SessionStoreManager,
} from '@particle-academy/prism-harness';

/** What this app keeps per agent. */
export interface SeatMemory {
  /** The agent CLI's own session id, for `--resume`. Null until it reports one. */
  readonly cliSessionId: string | null;
  readonly spoke: number;
}

const CAPABILITY = 'consensus-room';

export interface SeatSessionsOptions {
  /**
   * Where durable state lives.
   *
   * A real path for a room meant to survive a restart. Omitted gets a temp
   * directory — NOT an in-memory store, because the harness refuses one in the
   * durable slot and is right to: `volatileDurableStore` fires the moment a
   * configuration would lose work, and it fired on the first attempt here. A
   * memory-backed "durable" store is the bug that looks like a convenience.
   */
  readonly directory?: string;
}

/**
 * The harness sessions for one room.
 *
 * Built per room rather than globally, because `scope` is the room: two rooms
 * holding an agent with the same id must not share its memory, or a question
 * answered in one would be remembered in the other.
 */
export class SeatSessions {
  readonly #roomId: string;
  readonly #stores: SessionStoreManager;

  constructor(roomId: string, options: SeatSessionsOptions = {}) {
    this.#roomId = roomId;

    const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'consensus-'));

    // Named drivers, resolved lazily and each built at most once -- the
    // harness's own shape, not a pair of factories reached for directly.
    //
    // Ephemeral stays in memory deliberately: it is DEFINED as the state that
    // may be lost, and persisting it would make a crash recover something the
    // design says is allowed to vanish.
    this.#stores = new SessionStoreManager({
      stores: { durable: 'disk', ephemeral: 'memory' },
      drivers: {
        disk: () => new FileSessionStore(directory),
        memory: () => new MemorySessionStore(),
      },
    });
  }

  #session(participantId: string): Session {
    return new Session({
      participant: { type: 'agent', id: participantId },
      scope: this.#roomId,
      durable: this.#stores.durable(),
      ephemeral: this.#stores.ephemeral(),
    });
  }

  /** What this agent remembers. Defaults are "nothing yet", not zeroes-as-facts. */
  async read(participantId: string): Promise<SeatMemory> {
    const state = await this.#session(participantId).capability(CAPABILITY);
    return {
      cliSessionId: typeof state?.cliSessionId === 'string' ? state.cliSessionId : null,
      spoke: typeof state?.spoke === 'number' ? state.spoke : 0,
    };
  }

  /** Record what this agent now knows. */
  async write(participantId: string, memory: SeatMemory): Promise<void> {
    await this.#session(participantId).usingCapability(CAPABILITY, {
      cliSessionId: memory.cliSessionId,
      spoke: memory.spoke,
    });
  }

  /** Forget one agent entirely. */
  async forget(participantId: string): Promise<void> {
    await this.#session(participantId).forgetCapability(CAPABILITY);
  }
}
