import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSeat, type SeatDriver } from '../src/agents.js';
import { createConsensusServer } from '../src/server.js';

/** A seat whose agent always replies the same way, so no CLI is spawned. */
function fakeSeat(participantId: string, name: string, cwd: string): AgentSeat {
  const factory = (): SeatDriver => {
    let events: Parameters<SeatDriver['on']>[0] | null = null;
    return {
      on(e) {
        events = e;
      },
      start() {},
      prompt() {
        events?.onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${name} says yes.\nVOTE: agree — fine by me` },
        });
      },
      endInput() {
        events?.onExit(0);
      },
      get cliSessionId() {
        return `cli-${participantId}`;
      },
    };
  };
  return new AgentSeat({ id: participantId, kind: 'agent', name }, { cwd, driverFactory: factory });
}

let app: ReturnType<typeof createConsensusServer>;
let base: string;

beforeEach(async () => {
  app = createConsensusServer({ cwd: process.cwd(), seatFactory: fakeSeat, quietMs: 20 });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  await app.close();
});

interface Client {
  readonly cookie: string;
  readonly roomId: string;
}

async function openRoom(name = 'Wish'): Promise<Client> {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { roomId } = (await res.json()) as { roomId: string };
  return { cookie, roomId };
}

async function post(client: Client, action: string, body: unknown = {}) {
  const res = await fetch(`${base}/api/rooms/${client.roomId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the human token is the only way in', () => {
  it('sets an HttpOnly, SameSite cookie on room creation', async () => {
    // HttpOnly so page scripts cannot read it and therefore cannot leak it
    // into anything an agent might later see.
    const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses every room action with no cookie', async () => {
    const client = await openRoom();
    for (const action of ['question', 'say', 'vote', 'round', 'agents']) {
      const res = await fetch(`${base}/api/rooms/${client.roomId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, action).toBe(401);
    }
  });

  it('refuses a cookie from a DIFFERENT room', async () => {
    // The check that is easy to omit: a valid token is not a token for every
    // room. Without it, one room's human could drive another's agents.
    const mine = await openRoom('Wish');
    const theirs = await openRoom('Someone else');
    const crossed = { cookie: theirs.cookie, roomId: mine.roomId };
    expect((await post(crossed, 'question', { question: 'hijack?' })).status).toBe(401);
  });

  it('refuses a made-up token', async () => {
    const client = await openRoom();
    const forged = { cookie: 'consensus_token=' + 'a'.repeat(64), roomId: client.roomId };
    expect((await post(forged, 'say', { text: 'hello' })).status).toBe(401);
  });

  it('404s an unknown room before asking about the token', async () => {
    const res = await fetch(`${base}/api/rooms/room_999`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

describe('seeding and saying', () => {
  it('seeds the question and reports it', async () => {
    const client = await openRoom();
    const { status, body } = await post(client, 'question', { question: 'Adopt ACP?' });
    expect(status).toBe(200);
    expect(body.question).toBe('Adopt ACP?');
  });

  it('refuses a second question', async () => {
    const client = await openRoom();
    await post(client, 'question', { question: 'first' });
    const again = await post(client, 'question', { question: 'second' });
    expect(again.status).toBe(400);
    expect(String(again.body.error)).toMatch(/already set/);
  });

  it('attributes the human message to the human', async () => {
    const client = await openRoom('Wish');
    await post(client, 'question', { question: 'Adopt ACP?' });
    const { body } = await post(client, 'say', { text: 'What do you think?' });
    const transcript = body.transcript as Array<{ name: string; kind: string }>;
    expect(transcript).toEqual([
      expect.objectContaining({ name: 'Wish', kind: 'human', text: 'What do you think?' }),
    ]);
  });
});

describe('voting over HTTP', () => {
  it('records the human response, with the reason from the fixed table', async () => {
    // The human supplies a KEY, never a reason. The text in the room is this
    // app's own, which is what keeps human input out of an agent's prompt.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    const { body } = await post(client, 'vote', { response: 'reject-too-long' });
    const votes = body.votes as Array<{ participantId: string; choice: string; reason: string }>;
    expect(votes).toEqual([
      expect.objectContaining({ participantId: 'human', choice: 'disagree', reason: 'Too long' }),
    ]);
  });

  it('accepts each of the six, and nothing else', async () => {
    const expected: Record<string, string> = {
      accept: 'agree',
      'reject-too-long': 'disagree',
      'reject-not-clear': 'disagree',
      'reject-wrong-direction': 'disagree',
      'pass-agents-decide': 'pass',
      'pass-not-interested': 'pass',
    };

    for (const [key, choice] of Object.entries(expected)) {
      const client = await openRoom();
      await post(client, 'question', { question: 'Adopt ACP?' });
      const { body } = await post(client, 'vote', { response: key });
      const votes = body.votes as Array<{ choice: string }>;
      expect(votes[0]?.choice, key).toBe(choice);
    }
  });

  it('REFUSES an unknown response rather than defaulting it', async () => {
    // Defaulting an unrecognised key to `accept` would turn a typo into
    // agreement. A malformed request must never become a vote in favour.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    for (const response of ['yes', '', null, 'Accept', 'agree', 42, '__proto__']) {
      const res = await post(client, 'vote', { response });
      expect(res.status, JSON.stringify(response)).toBe(400);
    }
  });

  it('ignores a choice or reason in the body, because neither is a parameter', async () => {
    // Even a well-formed response key cannot smuggle a choice: the table
    // decides what the key means.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    const { body } = await post(client, 'vote', {
      response: 'accept',
      choice: 'disagree',
      reason: 'injected',
    });
    const votes = body.votes as Array<{ choice: string; reason: string }>;
    expect(votes[0]).toMatchObject({ choice: 'agree', reason: 'Accept' });
  });

  it('ignores a participantId in the body, because there is no parameter for one', async () => {
    // The forgery attempt at the HTTP edge. The id is simply not read: the
    // voter comes from the cookie.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'agents', { name: 'Ada' });
    const { body } = await post(client, 'vote', {
      response: 'accept',
      participantId: 'agent_1',
      voterId: 'agent_1',
    });
    const votes = body.votes as Array<{ participantId: string }>;
    expect(votes).toEqual([expect.objectContaining({ participantId: 'human' })]);
  });

  it('refuses a vote before the question is seeded', async () => {
    const client = await openRoom();
    expect((await post(client, 'vote', { response: 'accept' })).status).toBe(400);
  });

  it('offers exactly the six responses in its state', async () => {
    const client = await openRoom();
    const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
      headers: { cookie: client.cookie },
    });
    const body = (await res.json()) as { responses: Array<{ key: string; label: string }> };
    expect(body.responses.map((r) => r.label)).toEqual([
      'Accept',
      'Reject: Too Long',
      'Reject: Not Clear',
      'Reject: Wrong Direction',
      'Pass: Agents Decide',
      'Pass: Not Interested',
    ]);
  });
});

describe('Go and Stop', () => {
  it('refuses Go with no question', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    expect((await post(client, 'go')).status).toBe(400);
  });

  it('refuses Go with no agents', async () => {
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    const res = await post(client, 'go');
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/add an agent/);
  });

  it('starts a loop PER AGENT, with no rounds anywhere', async () => {
    // Each agent lives independently. There is no round counter to assert
    // because there are no rounds -- what the state carries is one presence per
    // agent, each saying what it is doing.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'agents', { name: 'Bob' });
    await post(client, 'question', { question: 'Adopt ACP?' });

    const go = await post(client, 'go');
    expect(go.status).toBe(200);

    const presences = go.body.presences as Array<{ participantId: string; running: boolean }>;
    expect(presences.map((p) => p.participantId).sort()).toEqual(['agent_1', 'agent_2']);
    expect(presences.every((p) => p.running)).toBe(true);
    expect(go.body).not.toHaveProperty('loop');

    await post(client, 'stop');
  }, 30_000);

  it('agents speak without being asked, and keep answering each other', async () => {
    // TWO agents, because one is the wrong test and the first version of this
    // used one and failed. A lone agent speaks once and then correctly waits:
    // "nothing new since I last spoke" is the rule that stops agents filling a
    // transcript with restatements. It takes a second participant for there to
    // be anything to answer.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'agents', { name: 'Bob' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');

    // Four messages means the exchange went past one each: nothing between
    // them asked anybody to speak again.
    for (let waited = 0; waited < 300; waited++) {
      const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
        headers: { cookie: client.cookie },
      });
      const state = (await res.json()) as { transcript: unknown[] };
      if (state.transcript.length >= 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const stopped = await post(client, 'stop');
    expect((stopped.body.transcript as unknown[]).length).toBeGreaterThanOrEqual(4);
    const spoke = (stopped.body.presences as Array<{ spoke: number }>).map((p) => p.spoke);
    expect(spoke.every((n) => n >= 1)).toBe(true);
  }, 30_000);

  it('a LONE agent speaks once and then waits, rather than restating itself', async () => {
    // The other half of the same rule, asserted so it cannot quietly become a
    // chatterbox: with nobody to answer, an agent that kept going would burn
    // the human's subscription to add no information.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stopped = await post(client, 'stop');

    expect((stopped.body.presences as Array<{ spoke: number }>)[0]?.spoke).toBe(1);
  }, 30_000);

  it('Stop means every agent HAS stopped when the request returns', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'agents', { name: 'Bob' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');

    const stopped = await post(client, 'stop');
    const presences = stopped.body.presences as Array<{ running: boolean }>;
    expect(presences.every((p) => !p.running)).toBe(true);
    expect(stopped.body.running).toBe(false);
    // And the floor is released, or the room would look permanently busy.
    expect(stopped.body.floorHeldBy).toBeNull();
  }, 30_000);

  it('Go twice does not start a second loop per agent', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');
    const again = await post(client, 'go');

    expect(again.status).toBe(200);
    const presences = again.body.presences as Array<{ participantId: string }>;
    expect(presences).toHaveLength(1);
    await post(client, 'stop');
  }, 30_000);

  it('Stop on a room that was never started is harmless', async () => {
    const client = await openRoom();
    expect((await post(client, 'stop')).status).toBe(200);
  });

  it('only ONE agent holds the floor at a time', async () => {
    // Several agents streaming at once produces interleaved half-sentences
    // nobody can read. The floor is observed by each agent, not handed out.
    const client = await openRoom();
    for (const name of ['Ada', 'Bob', 'Cal']) await post(client, 'agents', { name });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');

    for (let sampled = 0; sampled < 40; sampled++) {
      const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
        headers: { cookie: client.cookie },
      });
      const state = (await res.json()) as {
        presences: Array<{ doing: string }>;
        floorHeldBy: string | null;
      };
      expect(state.presences.filter((p) => p.doing === 'speaking').length).toBeLessThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await post(client, 'stop');
  }, 30_000);

  it('records the votes agents cast as they speak', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');

    for (let waited = 0; waited < 200; waited++) {
      const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
        headers: { cookie: client.cookie },
      });
      const state = (await res.json()) as { votes: unknown[] };
      if (state.votes.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const stopped = await post(client, 'stop');
    const votes = stopped.body.votes as Array<{ participantId: string; choice: string }>;
    expect(votes).toEqual([expect.objectContaining({ participantId: 'agent_1', choice: 'agree' })]);
  }, 30_000);

  it('stays UNDECIDED while the human has not responded', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stopped = await post(client, 'stop');
    expect(stopped.body.consensus).toMatchObject({ reached: false, agreed: null });
  }, 30_000);
});

describe('input handling', () => {
  it('strips control characters from a name', async () => {
    // A name is rendered in a page and fed into an agent's prompt, so it is
    // untrusted on both counts.
    const client = await openRoom('Wi\u0000sh\u001b[31m');
    const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
      headers: { cookie: client.cookie },
    });
    const body = (await res.json()) as { participants: Array<{ name: string }> };
    expect(body.participants[0]?.name).toBe('Wish[31m');
  });

  it('refuses a body that is not JSON', async () => {
    const client = await openRoom();
    const res = await fetch(`${base}/api/rooms/${client.roomId}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: client.cookie },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });

  it('serves the page at the root', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Consensus room');
  });
});

describe('the live stream', () => {
  it('sends the current state immediately on connect', async () => {
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });

    const res = await fetch(`${base}/api/rooms/${client.roomId}/events`, {
      headers: { cookie: client.cookie },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value);

    // Named events, because a chunk of streamed text is not a state snapshot
    // and a client should not have to guess which it received.
    expect(text).toContain('event: state');
    const data = text.split('data: ')[1] ?? '';
    expect(JSON.parse(data.trim())).toMatchObject({ question: 'Adopt ACP?' });
    await reader?.cancel();
  });

  it('refuses the stream without a cookie, so state is not readable', async () => {
    const client = await openRoom();
    const res = await fetch(`${base}/api/rooms/${client.roomId}/events`);
    expect(res.status).toBe(401);
  });
});
