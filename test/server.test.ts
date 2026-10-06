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
  app = createConsensusServer({ cwd: process.cwd(), seatFactory: fakeSeat });
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
  it('records the human vote against the human', async () => {
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    const { body } = await post(client, 'vote', { choice: 'agree', reason: 'it is reversible' });
    const votes = body.votes as Array<{ participantId: string; choice: string; reason: string }>;
    expect(votes).toEqual([
      expect.objectContaining({ participantId: 'human', choice: 'agree', reason: 'it is reversible' }),
    ]);
  });

  it('REFUSES a malformed choice rather than defaulting it', async () => {
    // Defaulting a malformed vote to `agree` is the one direction that must
    // never happen in a consensus room.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    for (const choice of ['yes', '', null, 'AGREE', 42]) {
      const res = await post(client, 'vote', { choice });
      expect(res.status, JSON.stringify(choice)).toBe(400);
    }
  });

  it('ignores a participantId in the body, because there is no parameter for one', async () => {
    // The forgery attempt at the HTTP edge. The id is simply not read: the
    // voter comes from the cookie.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'agents', { name: 'Ada' });
    const { body } = await post(client, 'vote', {
      choice: 'agree',
      participantId: 'agent_1',
      voterId: 'agent_1',
    });
    const votes = body.votes as Array<{ participantId: string }>;
    expect(votes).toEqual([expect.objectContaining({ participantId: 'human' })]);
  });

  it('refuses a vote before the question is seeded', async () => {
    const client = await openRoom();
    expect((await post(client, 'vote', { choice: 'agree' })).status).toBe(400);
  });
});

describe('rounds', () => {
  it('runs every agent and records their votes', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'agents', { name: 'Bob' });
    await post(client, 'question', { question: 'Adopt ACP?' });

    const { status, body } = await post(client, 'round');
    expect(status).toBe(200);

    const votes = body.votes as Array<{ participantId: string; choice: string }>;
    expect(votes.map((v) => v.participantId).sort()).toEqual(['agent_1', 'agent_2']);
  });

  it('reaches consensus once the human votes too', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'round');
    const { body } = await post(client, 'vote', { choice: 'agree' });

    expect(body.consensus).toMatchObject({ reached: true, agreed: true });
  });

  it('stays UNDECIDED while the human has not voted', async () => {
    // agreed: null, not false. The agents agreeing is not the room deciding.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    const { body } = await post(client, 'round');
    expect(body.consensus).toMatchObject({ reached: false, agreed: null });
  });

  it('refuses a round with no question', async () => {
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    expect((await post(client, 'round')).status).toBe(400);
  });

  it('refuses a round with no agents', async () => {
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    const res = await post(client, 'round');
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/add an agent/);
  });

  it('clears the running flag after a round, so later rounds are not locked out', async () => {
    // Set in a `finally`: a round that threw must not leave the room
    // permanently "running", which would 409 every later round and read as the
    // app hanging.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'round');
    expect((await post(client, 'round')).status).toBe(200);
  });
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
    expect(text).toContain('data: ');
    expect(JSON.parse(text.replace(/^data: /, '').trim())).toMatchObject({
      question: 'Adopt ACP?',
    });
    await reader?.cancel();
  });

  it('refuses the stream without a cookie, so state is not readable', async () => {
    const client = await openRoom();
    const res = await fetch(`${base}/api/rooms/${client.roomId}/events`);
    expect(res.status).toBe(401);
  });
});
