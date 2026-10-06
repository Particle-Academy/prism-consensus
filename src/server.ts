/**
 * The HTTP surface: one page, a small JSON API, and a live stream.
 *
 * Zero runtime dependencies beyond `prism-acp` itself — `node:http` and a
 * hand-written page. That is not asceticism: this app exists to exercise the
 * transport, and every dependency it adds is a thing that could be blamed when
 * something misbehaves.
 *
 * ## Two ingress paths, and that is the security design
 *
 * The human arrives over HTTP with a room token. An agent arrives through its
 * own `prism-acp` session. Each path mints its own {@link Principal}, and
 * neither can mint the other's:
 *
 * - the human's token is held by their browser and never shown to an agent —
 *   not in a prompt, not in a transcript, not in a tool argument;
 * - an agent's identity comes from the seat whose session produced the text,
 *   and its own output has no say in it.
 *
 * So impersonation is not prevented by a check that could be forgotten. There
 * is no code path where a participant id arrives from a request body at all.
 *
 * ## Why the token is a cookie and not a query parameter
 *
 * The live stream uses `EventSource`, which cannot set headers, and the obvious
 * fix is `?token=…`. A room token is a credential, and credentials in URLs end
 * up in server logs, browser history and `Referer` headers. So it travels as an
 * `HttpOnly` cookie, which `EventSource` sends on a same-origin request anyway.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentSeat } from './agents.js';
import { render } from './conversation.js';
import { SeatSessions } from './harness.js';
import { AgentPresence, Presences } from './presence.js';
import { sanitiseName } from './names.js';
import { HUMAN_RESPONSES, RESPONSE_KEYS, humanResponse } from './responses.js';
import { Principal, Room, RoomError } from './room.js';

const COOKIE = 'consensus_token';

interface Session {
  readonly roomId: string;
  readonly participantId: string;
}

interface Live {
  readonly room: Room;
  readonly seats: AgentSeat[];
  readonly presences: AgentPresence[];
  readonly listeners: Set<ServerResponse>;
  /** Per-agent durable state, held by prism-harness. */
  readonly sessions: SeatSessions;
}

export interface ServerOptions {
  readonly port?: number;
  /** Working directory handed to each agent. */
  readonly cwd?: string;
  /** Overridable for tests, so no real agent is spawned. */
  readonly seatFactory?: (participantId: string, name: string, cwd: string) => AgentSeat;
  /** Where per-agent harness state lives. A temp directory when omitted. */
  readonly stateDirectory?: string;
  /** Quiet period before an agent replies. Two seconds unless a test shortens it. */
  readonly quietMs?: number;
  /** A frame, request or agent turn that could not be used. */
  readonly onProtocolError?: (roomId: string, problem: string) => void;
}

export function createConsensusServer(options: ServerOptions = {}) {
  const rooms = new Map<string, Live>();
  const sessions = new Map<string, Session>();
  const cwd = options.cwd ?? process.cwd();
  let counter = 0;

  const page = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)));

  function broadcast(live: Live): void {
    sendEvent(live, 'state', stateOf(live));
  }

  /**
   * Just the message being written.
   *
   * Separate from a full state push because a chunk arrives per token:
   * sending the whole transcript each time would make a long room quadratic
   * in its own length, and the browser would spend the conversation
   * re-rendering what it already has.
   */
  function broadcastLive(live: Live): void {
    sendEvent(live, 'live', { live: live.room.live, floorHeldBy: live.room.floorHeldBy });
  }

  function sendEvent(live: Live, event: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const listener of live.listeners) {
      listener.write(`event: ${event}\ndata: ${data}\n\n`);
    }
  }

  function stateOf(live: Live) {
    return {
      roomId: live.room.id,
      question: live.room.question,
      participants: live.room.participants,
      transcript: render(live.room),
      votes: live.room.votes,
      consensus: live.room.consensus(),
      // The six the human may pick, sent to the client so the buttons and the
      // server cannot disagree about what exists.
      responses: Object.entries(HUMAN_RESPONSES).map(([key, r]) => ({ key, label: r.label })),
      // What is being written right now, so a surface can render a message
      // that is not finished. Null when the room is quiet -- which is "nobody
      // is speaking", not "there is no message".
      live: live.room.live,
      floorHeldBy: live.room.floorHeldBy,
      presences: new Presences(live.presences).states,
      running: new Presences(live.presences).running,
    };
  }

  /**
   * Resolve the human from their cookie.
   *
   * The ONLY place a human Principal is minted. Everything else takes a
   * Principal as an argument, so there is no second route to one.
   */
  function human(req: IncomingMessage, roomId: string): { live: Live; who: Principal } {
    const token = cookieOf(req.headers.cookie, COOKIE);
    const session = token === null ? undefined : sessions.get(token);
    const live = rooms.get(roomId);

    if (live === undefined) throw new HttpError(404, 'no such room');
    // Checked together: a valid token for a DIFFERENT room must not authorise
    // anything here, or one room's human could drive another's.
    if (session === undefined || session.roomId !== roomId) {
      throw new HttpError(401, 'not authenticated for this room');
    }
    return { live, who: Principal.authenticated(session.participantId, 'human') };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      const status = cause instanceof HttpError ? cause.status : 500;
      const message =
        cause instanceof HttpError || cause instanceof RoomError
          ? cause.message
          : 'internal error';
      // A RoomError is the domain refusing something -- "only the human may
      // seed the question" -- and the caller should see which. An unexpected
      // throw is not described, because its message may carry internals.
      send(res, status === 500 && cause instanceof RoomError ? 400 : status, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    if (method === 'POST' && path === '/api/rooms') {
      const body = await readJson(req);
      const roomId = `room_${++counter}`;
      const room = new Room(roomId);
      const participantId = 'human';
      room.join({ id: participantId, kind: 'human', name: sanitiseName(body.name, 'You') });

      const live: Live = {
        room,
        seats: [],
        presences: [],
        listeners: new Set(),
        sessions: new SeatSessions(roomId, options.stateDirectory === undefined ? {} : { directory: options.stateDirectory }),
      };
      rooms.set(roomId, live);

      // 32 random bytes. Guessing one is the only way to impersonate the human
      // over HTTP, so it is not a counter and not a uuid-v1.
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { roomId, participantId });

      res.writeHead(200, {
        'content-type': 'application/json',
        // HttpOnly so page scripts cannot read it, and therefore cannot leak it
        // into anything an agent might later see.
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(JSON.stringify({ roomId }));
      return;
    }

    const match = /^\/api\/rooms\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (match === null) {
      send(res, 404, { error: 'not found' });
      return;
    }

    const roomId = match[1]!;
    const action = match[2];

    if (method === 'GET' && action === 'events') {
      const { live } = human(req, roomId);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      live.listeners.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(stateOf(live))}\n\n`);
      req.on('close', () => live.listeners.delete(res));
      return;
    }

    if (method === 'GET' && action === undefined) {
      const { live } = human(req, roomId);
      send(res, 200, stateOf(live));
      return;
    }

    if (method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
      return;
    }

    const { live, who } = human(req, roomId);
    const body = await readJson(req);

    switch (action) {
      case 'agents': {
        const name = sanitiseName(body.name, `Agent ${live.seats.length + 1}`);
        const id = `agent_${live.seats.length + 1}`;
        live.room.join({ id, kind: 'agent', name });
        const factory =
          options.seatFactory ??
          ((participantId, agentName, at) =>
            new AgentSeat({ id: participantId, kind: 'agent', name: agentName }, { cwd: at }));
        const seat = factory(id, name, cwd);
        live.seats.push(seat);

        // Rehydrated from the harness BEFORE the agent can speak, so an agent
        // in a restarted room resumes its own CLI conversation instead of
        // starting a fresh one while the transcript implies continuity.
        const remembered = await live.sessions.read(id);
        if (remembered.cliSessionId !== null) seat.resumeFrom(remembered.cliSessionId);

        live.presences.push(
          new AgentPresence(seat, live.room, {
            ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
            onChange: () => broadcast(live),
            onChunk: () => broadcastLive(live),
            onError: (participantId, problem) =>
              options.onProtocolError?.(live.room.id, `${participantId}: ${problem}`),
            onSpoke: (participantId, cliSessionId, spoke) => {
              void live.sessions.write(participantId, { cliSessionId, spoke });
            },
          }),
        );
        break;
      }

      case 'question':
        live.room.seedQuestion(who, String(body.question ?? ''));
        break;

      case 'say':
        live.room.say(who, String(body.text ?? ''));
        break;

      case 'vote': {
        // The human picks one of six; they do not supply a choice or a reason.
        // A free-text reason would be untrusted input on its way into an
        // agent's prompt, and there is no need for one.
        const response = humanResponse(body.response);
        if (response === null) {
          throw new HttpError(400, `response must be one of: ${RESPONSE_KEYS.join(', ')}`);
        }
        live.room.castVote(who, response.choice, response.reason);
        break;
      }

      case 'go': {
        if (live.room.question === null) throw new HttpError(400, 'seed the question first');
        if (live.presences.length === 0) throw new HttpError(400, 'add an agent first');

        // Each agent starts its OWN loop. Nothing schedules them and nothing
        // counts rounds: they watch the room and decide when to speak.
        // Idempotent per agent, so a double-click cannot start a second loop
        // for one agent and double its turns along with the bill.
        new Presences(live.presences).start();
        break;
      }

      case 'stop':
        // Awaited, so the response means every agent HAS stopped rather than
        // that the request was heard. A Stop that returns while agents are
        // still writing is the button the human presses again.
        await new Presences(live.presences).stop();
        break;

      default:
        send(res, 404, { error: 'not found' });
        return;
    }

    broadcast(live);
    send(res, 200, stateOf(live));
  }

  return {
    server,
    listen: async (port = options.port ?? 8099) =>
      await new Promise<number>((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      }),
    close: async () => {
      // Loops first: a running loop spawns agent processes, and closing the
      // socket while one is mid-round would leave real children behind with
      // nothing listening to them.
      await Promise.all(
        [...rooms.values()].map(async (live) => await new Presences(live.presences).stop()),
      );
      return await new Promise<void>((resolve) => {
        for (const live of rooms.values()) {
          for (const listener of live.listeners) listener.end();
        }
        server.close(() => resolve());
      });
    },
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    // A cap, because an unbounded body is a trivial way to exhaust memory and
    // nothing here needs a large one.
    if (bytes > 64 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

/** Read one cookie without a dependency, and without trusting its shape. */
function cookieOf(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}


