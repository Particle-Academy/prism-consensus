import { describe, expect, it } from 'vitest';
import { AgentSeat, type SeatDriver } from '../src/agents.js';
import { DiscussionLoop } from '../src/loop.js';
import { Principal, Room, type Participant } from '../src/room.js';

/**
 * A driver that takes a controllable amount of time and can be killed.
 *
 * The slow case is the one that matters: a loop is only testable for
 * responsiveness if a turn can be caught in flight.
 */
function seatDriver(options: {
  reply?: string;
  delayMs?: number;
  exitCode?: number;
}): { factory: () => SeatDriver; started: () => number; killed: () => number } {
  let starts = 0;
  let kills = 0;

  const factory = (): SeatDriver => {
    let events: Parameters<SeatDriver['on']>[0] | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      events?.onExit(code);
    };

    return {
      on(e) {
        events = e;
      },
      start() {
        starts += 1;
      },
      prompt() {
        timer = setTimeout(() => {
          events?.onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: options.reply ?? 'Fine.\nVOTE: agree' },
          });
          finish(options.exitCode ?? 0);
        }, options.delayMs ?? 1);
      },
      endInput() {},
      kill() {
        kills += 1;
        // A killed child exits non-zero, which is how an aborted turn becomes
        // an errored one and therefore records nothing.
        finish(137);
      },
      get cliSessionId() {
        return 'cli-1';
      },
    };
  };

  return { factory, started: () => starts, killed: () => kills };
}

const ada: Participant = { id: 'a1', kind: 'agent', name: 'Ada' };
const bob: Participant = { id: 'a2', kind: 'agent', name: 'Bob' };

function room(...agents: Participant[]) {
  const r = new Room('r1');
  r.join({ id: 'h1', kind: 'human', name: 'Wish' });
  for (const agent of agents) r.join(agent);
  r.seedQuestion(Principal.authenticated('h1', 'human'), 'Adopt ACP?');
  return r;
}

async function until(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Go runs until Stop and nothing else', () => {
  it('keeps going after every agent has voted', async () => {
    // The instruction, asserted. A halt-when-everyone-has-voted loop -- the
    // obvious implementation -- would stop at round 1 here, because the single
    // agent votes on its first turn every time.
    const d = seatDriver({});
    const r = room(ada);
    const loop = new DiscussionLoop(r, [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })], {
      pauseMs: 5,
    });

    loop.start();
    await until(() => loop.state.round >= 3);
    await loop.stop();

    expect(loop.state.round).toBeGreaterThanOrEqual(3);
    expect(r.votes).toHaveLength(1); // one agent, one vote, replaced each round
  });

  it('keeps going after consensus is reached', async () => {
    // Agreement is not a stop condition: the point of the room is whether
    // agreement SURVIVES more discussion.
    const d = seatDriver({});
    const r = room(ada);
    r.castVote(Principal.authenticated('h1', 'human'), 'agree');
    const loop = new DiscussionLoop(r, [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })], {
      pauseMs: 5,
    });

    loop.start();
    await until(() => loop.state.round >= 1);
    expect(r.consensus()).toMatchObject({ reached: true, agreed: true });

    const reached = loop.state.round;
    await until(() => loop.state.round > reached);
    await loop.stop();
  });

  it('reports running, then stopped', async () => {
    const d = seatDriver({});
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })],
      { pauseMs: 5 },
    );

    expect(loop.state.running).toBe(false);
    loop.start();
    expect(loop.state.running).toBe(true);
    await loop.stop();
    expect(loop.state).toMatchObject({ running: false, stopping: false });
  });
});

describe('Stop is prompt, not polite', () => {
  it('kills an in-flight turn rather than waiting it out', async () => {
    // A room of several agents takes tens of seconds to drain. A Stop that
    // waited would read as a broken button, which invites a second press.
    const d = seatDriver({ delayMs: 60_000 });
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })],
      { pauseMs: 5 },
    );

    loop.start();
    await until(() => d.started() > 0);

    const began = Date.now();
    await loop.stop();

    expect(d.killed()).toBeGreaterThan(0);
    // Far below the 60s turn: the point is that it did not wait for it.
    expect(Date.now() - began).toBeLessThan
      (5000);
  });

  it('does not count an aborted round', async () => {
    // Counting it would make the round number claim work that was cancelled.
    const d = seatDriver({ delayMs: 60_000 });
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })],
      { pauseMs: 5 },
    );

    loop.start();
    await until(() => d.started() > 0);
    await loop.stop();

    expect(loop.state.round).toBe(0);
  });

  it('records nothing from an aborted turn', async () => {
    // A turn the human cancelled halfway is not a contribution, and half of one
    // would put words in an agent's mouth it had not finished saying.
    const d = seatDriver({ delayMs: 60_000 });
    const r = room(ada);
    const loop = new DiscussionLoop(r, [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })], {
      pauseMs: 5,
    });

    loop.start();
    await until(() => d.started() > 0);
    await loop.stop();

    expect(r.messages).toEqual([]);
    expect(r.votes).toEqual([]);
  });

  it('is harmless when it was never started, and twice over', async () => {
    const d = seatDriver({});
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })],
      { pauseMs: 5 },
    );
    await loop.stop();
    loop.start();
    await loop.stop();
    await loop.stop();
    expect(loop.state.running).toBe(false);
  });
});

describe('failure handling', () => {
  it('backs off only when EVERY agent failed', async () => {
    // One failing agent among several is a normal round: the others spoke, and
    // slowing the room down would punish the participants that worked.
    const ok = seatDriver({});
    const bad = seatDriver({ exitCode: 1 });
    const loop = new DiscussionLoop(
      room(ada, bob),
      [
        new AgentSeat(ada, { cwd: '/w', driverFactory: ok.factory }),
        new AgentSeat(bob, { cwd: '/w', driverFactory: bad.factory }),
      ],
      { pauseMs: 5, backoffMs: 60_000 },
    );

    loop.start();
    // If a half-failed round triggered the 60s backoff, round 2 would never
    // arrive inside this window.
    await until(() => loop.state.round >= 2, 4000);
    await loop.stop();
    expect(loop.state.lastError).toBeNull();
  });

  it('reports the error when every agent failed', async () => {
    const bad = seatDriver({ exitCode: 1 });
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: bad.factory })],
      { pauseMs: 5, backoffMs: 20 },
    );

    loop.start();
    await until(() => loop.state.round >= 1);
    await loop.stop();
    expect(loop.state.lastError).toMatch(/exited with code 1/);
  });

  it('keeps trying after a total failure rather than giving up', async () => {
    // Backoff is not a stop. Only Stop is a stop.
    const bad = seatDriver({ exitCode: 1 });
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: bad.factory })],
      { pauseMs: 5, backoffMs: 20 },
    );

    loop.start();
    await until(() => loop.state.round >= 3);
    await loop.stop();
    expect(loop.state.running).toBe(false);
  });
});

describe('start refuses an unready room', () => {
  it('refuses with no agents', () => {
    const r = room();
    expect(() => new DiscussionLoop(r, []).start()).toThrow(/add an agent/);
  });

  it('refuses with no question', () => {
    const r = new Room('r1');
    r.join({ id: 'h1', kind: 'human', name: 'Wish' });
    r.join(ada);
    const d = seatDriver({});
    expect(() =>
      new DiscussionLoop(r, [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })]).start(),
    ).toThrow(/seed the question/);
  });

  it('does not start a second loop on a second Go', async () => {
    // Which would double every agent's turns and the bill with them.
    const d = seatDriver({ delayMs: 50 });
    const loop = new DiscussionLoop(
      room(ada),
      [new AgentSeat(ada, { cwd: '/w', driverFactory: d.factory })],
      { pauseMs: 5 },
    );

    loop.start();
    loop.start();
    loop.start();
    await until(() => loop.state.round >= 1);
    await loop.stop();

    // Three Gos, one loop: starts should track rounds, not Gos.
    expect(d.started()).toBeLessThanOrEqual(loop.state.round + 1);
  });
});
