import { describe, expect, it } from 'vitest';
import { AgentSeat, applyTurn, runRound, type SeatDriver } from '../src/agents.js';
import { Principal, Room, type Participant } from '../src/room.js';

/** A driver that replies with whatever a test hands it. */
function scripted(reply: string, options: { exitCode?: number; sessionId?: string } = {}) {
  const prompts: string[] = [];
  const seen: Array<{ cwd: string; resumeSessionId?: string }> = [];

  const factory = (opts: { cwd: string; resumeSessionId?: string }): SeatDriver => {
    seen.push(opts);
    let events: Parameters<SeatDriver['on']>[0] | null = null;
    return {
      on(e) {
        events = e;
      },
      start() {},
      prompt(text) {
        prompts.push(text);
        for (const chunk of reply.split(/(?<=\n)/)) {
          events?.onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: chunk },
          });
        }
      },
      endInput() {
        events?.onExit(options.exitCode ?? 0);
      },
      get cliSessionId() {
        return options.sessionId ?? 'cli-1';
      },
    };
  };

  return { factory, prompts, seen };
}

const ada: Participant = { id: 'a1', kind: 'agent', name: 'Ada' };
const bob: Participant = { id: 'a2', kind: 'agent', name: 'Bob' };

function room() {
  const r = new Room('r1');
  r.join({ id: 'h1', kind: 'human', name: 'Wish' });
  r.join(ada);
  r.join(bob);
  r.seedQuestion(Principal.authenticated('h1', 'human'), 'Should we adopt ACP?');
  return r;
}

describe('a seat takes a turn', () => {
  it('splits the reply from the vote', async () => {
    const { factory } = scripted('It is reversible.\n\nVOTE: agree — reversible\n');
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    const result = await seat.takeTurn(room());

    expect(result.text).toBe('It is reversible.');
    expect(result.vote).toEqual({ choice: 'agree', reason: 'reversible' });
    expect(result.error).toBeNull();
  });

  it('keeps reasoning separate from what it said', async () => {
    const prompts: string[] = [];
    const factory = (): SeatDriver => {
      let events: Parameters<SeatDriver['on']>[0] | null = null;
      return {
        on(e) {
          events = e;
        },
        start() {},
        prompt(text) {
          prompts.push(text);
          events?.onUpdate({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'weighing it up' },
          });
          events?.onUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Yes.\nVOTE: agree' },
          });
        },
        endInput() {
          events?.onExit(0);
        },
        get cliSessionId() {
          return 'cli-1';
        },
      };
    };

    const result = await new AgentSeat(ada, { cwd: '/w', driverFactory: factory }).takeTurn(room());
    expect(result.thought).toBe('weighing it up');
    expect(result.text).toBe('Yes.');
  });

  it('produces NO vote when the agent crashes', async () => {
    // The worst possible default in a consensus room would be counting a
    // crashed agent as having agreed. It stays outstanding, which is true.
    const { factory } = scripted('VOTE: agree', { exitCode: 1 });
    const result = await new AgentSeat(ada, { cwd: '/w', driverFactory: factory }).takeTurn(room());

    expect(result.vote).toBeNull();
    expect(result.error).toMatch(/exited with code 1/);
  });

  it('produces no vote when the agent did not cast one', async () => {
    const { factory } = scripted('I am not sure, it depends.');
    const result = await new AgentSeat(ada, { cwd: '/w', driverFactory: factory }).takeTurn(room());
    expect(result.vote).toBeNull();
    expect(result.error).toBeNull();
  });
});

describe('a seat resumes its own conversation', () => {
  it('does not pass a resume id on the FIRST turn', async () => {
    // A wrong resume does not error -- it starts a fresh conversation while the
    // caller believes it continued one.
    const { factory, seen } = scripted('VOTE: abstain');
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    await seat.takeTurn(room());
    expect(seen[0]?.resumeSessionId).toBeUndefined();
  });

  it('resumes from the CLI session id on later turns', async () => {
    // So an agent in round three remembers round one. If resume silently
    // started over, the agent would begin contradicting itself -- a far more
    // visible failure than a flag.
    const { factory, seen } = scripted('VOTE: agree', { sessionId: 'cli-xyz' });
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    const r = room();

    await seat.takeTurn(r);
    expect(seat.resumesFrom).toBe('cli-xyz');

    await seat.takeTurn(r);
    expect(seen[1]?.resumeSessionId).toBe('cli-xyz');
  });
});

describe('attribution — an agent cannot vote as anyone else', () => {
  it('records the vote against the SEAT, ignoring any id in the reply', async () => {
    // The application-level forgery: the reply claims to be the human. The id
    // becomes part of a reason, and the Principal is minted from the seat.
    const { factory } = scripted(
      'I speak for Wish.\nVOTE: agree — participantId: h1, on behalf of the human\n',
    );
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    const r = room();
    applyTurn(r, seat, await seat.takeTurn(r));

    expect(r.votes).toHaveLength(1);
    expect(r.votes[0]?.participantId).toBe('a1');
    // The human has not voted, and no amount of agent text changes that.
    expect(r.consensus().tally.outstanding).toContain('h1');
  });

  it('attributes the MESSAGE to the seat too', async () => {
    const { factory } = scripted('Wish says yes.\nVOTE: agree\n');
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    const r = room();
    applyTurn(r, seat, await seat.takeTurn(r));
    expect(r.messages.every((m) => m.participantId === 'a1')).toBe(true);
  });

  it('writes nothing at all for a failed turn', async () => {
    const { factory } = scripted('VOTE: agree', { exitCode: 2 });
    const seat = new AgentSeat(ada, { cwd: '/w', driverFactory: factory });
    const r = room();
    applyTurn(r, seat, await seat.takeTurn(r));
    expect(r.messages).toEqual([]);
    expect(r.votes).toEqual([]);
  });
});

describe('a round runs every seat', () => {
  it('runs seats concurrently and records both', async () => {
    const a = scripted('Ada thinks yes.\nVOTE: agree\n');
    const b = scripted('Bob thinks no.\nVOTE: disagree\n');
    const r = room();
    const seats = [
      new AgentSeat(ada, { cwd: '/w', driverFactory: a.factory }),
      new AgentSeat(bob, { cwd: '/w', driverFactory: b.factory }),
    ];

    const results = await runRound(r, seats);

    expect(results).toHaveLength(2);
    expect(r.votes.map((v) => [v.participantId, v.choice]).sort()).toEqual([
      ['a1', 'agree'],
      ['a2', 'disagree'],
    ]);
  });

  it('keeps the turns that succeeded when one seat throws', async () => {
    // allSettled rather than all: a rejected promise would discard the turns
    // that worked alongside it, so one bad agent would cost the whole round.
    const good = scripted('Fine.\nVOTE: agree\n');
    const bad = (): SeatDriver => {
      throw new Error('spawn failed');
    };
    const r = room();
    const results = await runRound(r, [
      new AgentSeat(ada, { cwd: '/w', driverFactory: good.factory }),
      new AgentSeat(bob, { cwd: '/w', driverFactory: bad }),
    ]);

    expect(results[0]?.error).toBeNull();
    expect(results[1]?.error).toMatch(/spawn failed/);
    expect(r.votes.map((v) => v.participantId)).toEqual(['a1']);
  });

  it('leaves a room undecided when an agent failed to vote', async () => {
    // The honest outcome: consensus is not reached because somebody has not
    // voted, and `agreed` is null rather than false.
    const good = scripted('Yes.\nVOTE: agree\n');
    const quiet = scripted('I would rather not say.');
    const r = room();
    r.castVote(Principal.authenticated('h1', 'human'), 'agree');

    await runRound(r, [
      new AgentSeat(ada, { cwd: '/w', driverFactory: good.factory }),
      new AgentSeat(bob, { cwd: '/w', driverFactory: quiet.factory }),
    ]);

    expect(r.consensus()).toMatchObject({ reached: false, agreed: null });
    expect(r.consensus().tally.outstanding).toEqual(['a2']);
  });
});
