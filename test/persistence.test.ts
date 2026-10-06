/**
 * A room survives a restart — and so does the human's way into it.
 *
 * Every test here builds a server, kills it, and builds a NEW one over the same
 * directory. That is the only shape that proves anything: asserting a snapshot
 * was written proves a file exists, not that a room comes back.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSeat, type SeatDriver } from '../src/agents.js';
import { createConsensusServer } from '../src/server.js';
import { hashToken } from '../src/store.js';

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
          content: { type: 'text', text: `${name} says yes.\nVOTE: agree — fine` },
        });
      },
      endInput() {
        events?.onExit(0);
      },
      kill() {
        events?.onExit(137);
      },
      get cliSessionId() {
        return `cli-${participantId}`;
      },
    };
  };
  return new AgentSeat({ id: participantId, kind: 'agent', name }, { cwd, driverFactory: factory });
}

let directory: string;
let app: ReturnType<typeof createConsensusServer>;
let base: string;

function build() {
  return createConsensusServer({
    cwd: process.cwd(),
    seatFactory: fakeSeat,
    stateDirectory: directory,
    quietMs: 20,
  });
}

/** Stop the server and start a fresh one over the same directory. */
async function restart() {
  await app.close();
  app = build();
  base = `http://127.0.0.1:${String(await app.listen(0))}`;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'consensus-test-'));
  app = build();
  base = `http://127.0.0.1:${String(await app.listen(0))}`;
});

afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
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

async function read(client: Client) {
  const res = await fetch(`${base}/api/rooms/${client.roomId}`, {
    headers: { cookie: client.cookie },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('a room survives a restart', () => {
  it('brings back the question, the roster, the transcript and the votes', async () => {
    const client = await openRoom('Wish');
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'agents', { name: 'Bob' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'say', { text: 'What do you think?' });
    await post(client, 'vote', { response: 'accept' });

    await restart();

    const { status, body } = await read(client);
    expect(status).toBe(200);
    expect(body.question).toBe('Adopt ACP?');
    expect((body.participants as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'Wish',
      'Ada',
      'Bob',
    ]);
    expect((body.transcript as Array<{ text: string }>)[0]?.text).toBe('What do you think?');
    expect(body.votes).toEqual([
      expect.objectContaining({ participantId: 'human', choice: 'agree', reason: 'Accept' }),
    ]);
  });

  it('keeps the human authenticated with the SAME cookie', async () => {
    // Persisting the room without the session would be worse than not
    // persisting at all: the transcript comes back and its human is locked out.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });

    await restart();

    expect((await read(client)).status).toBe(200);
    expect((await post(client, 'say', { text: 'still me' })).status).toBe(200);
  });

  it('still refuses a cookie that was never issued', async () => {
    // The restore path must not become a way in. A token nobody minted resolves
    // to nothing whether or not the store has been consulted.
    const client = await openRoom();
    await post(client, 'question', { question: 'Adopt ACP?' });
    await restart();

    const forged = { cookie: `consensus_token=${'b'.repeat(64)}`, roomId: client.roomId };
    expect((await read(forged)).status).toBe(401);
  });

  it('still refuses a valid cookie for a DIFFERENT room', async () => {
    const mine = await openRoom('Wish');
    const theirs = await openRoom('Someone');
    await restart();
    expect((await read({ cookie: theirs.cookie, roomId: mine.roomId })).status).toBe(401);
  });

  it('stores the token as a HASH, never as a usable credential', async () => {
    // A credential written to disk is a credential readable off disk. The file
    // holds sha256(token); requests are hashed and looked up, so whoever reads
    // the directory gets nothing they can present.
    const client = await openRoom();
    const token = client.cookie.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(32);

    await post(client, 'question', { question: 'Adopt ACP?' });
    await app.close();

    const { readdirSync, readFileSync } = await import('node:fs');
    const dumped = readdirSync(directory)
      .map((f) => readFileSync(join(directory, f), 'utf8'))
      .join('\n');

    expect(dumped.length).toBeGreaterThan(0);
    expect(dumped).not.toContain(token);
    // And the hash IS there, so the absence above is redaction rather than the
    // session simply never having been written.
    expect(dumped).toContain(hashToken(token));
  });
});

describe('restored agents are real, not just listed', () => {
  it('rebuilds a seat per agent, so Go is accepted', async () => {
    // Without rebuilt seats a restored agent appears in the roster and is
    // inert: Go refuses the room for having no agents while the UI lists two.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });

    await restart();

    const go = await post(client, 'go');
    expect(go.status).toBe(200);
    const presences = go.body.presences as Array<{ participantId: string; running: boolean }>;
    expect(presences).toHaveLength(1);
    expect(presences[0]?.running).toBe(true);
    await post(client, 'stop');
  }, 20_000);

  it('comes back QUIET rather than resuming the conversation', async () => {
    // Agents talking into a room whose human may not be watching, spending
    // their subscription to do it, is not a restart -- it is a surprise. Go is
    // the human's to press.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });
    await post(client, 'go');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await post(client, 'stop');

    await restart();

    const { body } = await read(client);
    expect(body.running).toBe(false);
    expect((body.presences as Array<{ running: boolean }>).every((p) => !p.running)).toBe(true);
  }, 20_000);

  it('does not restore a live message or the floor', async () => {
    // A message half-written when the process died is not a message, and a
    // restored floor holder would leave the room permanently busy waiting for
    // an agent that no longer exists.
    const client = await openRoom();
    await post(client, 'agents', { name: 'Ada' });
    await post(client, 'question', { question: 'Adopt ACP?' });

    await restart();

    const { body } = await read(client);
    expect(body.live).toBeNull();
    expect(body.floorHeldBy).toBeNull();
  });

  it('does not collide a new room with a restored one', async () => {
    // `counter` names rooms, and a fresh process starting at 1 would hand the
    // next room an id a restored room already holds.
    const first = await openRoom('Wish');
    expect(first.roomId).toBe('room_1');

    await restart();

    const second = await openRoom('Someone');
    expect(second.roomId).not.toBe(first.roomId);
    expect((await read(first)).status).toBe(200);
  });
});

describe('without a state directory, nothing persists', () => {
  it('forgets the room, which is what a throwaway room should do', async () => {
    // Persistence is opted into. A test or a scratch room must not discover
    // that it outlived the process.
    const ephemeral = createConsensusServer({ cwd: process.cwd(), seatFactory: fakeSeat });
    const port = await ephemeral.listen(0);
    const at = `http://127.0.0.1:${String(port)}`;

    const res = await fetch(`${at}/api/rooms`, { method: 'POST' });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const { roomId } = (await res.json()) as { roomId: string };
    await ephemeral.close();

    const fresh = createConsensusServer({ cwd: process.cwd(), seatFactory: fakeSeat });
    const freshPort = await fresh.listen(0);
    const gone = await fetch(`http://127.0.0.1:${String(freshPort)}/api/rooms/${roomId}`, {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
    await fresh.close();
  });
});
