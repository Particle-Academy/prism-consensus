/**
 * Rooms that survive a restart.
 *
 * Built on the harness's `FileSessionStore`, which is a durable keyed
 * JSON store — the same component holding each agent's session, so this app has
 * one notion of persistence rather than two that agree by luck.
 *
 * ## The human's session has to survive too, and that is the hard part
 *
 * Persisting the room alone would be worse than not persisting it: the
 * transcript would come back and the human would be locked out of their own
 * room, because the token in their cookie no longer maps to anything. So the
 * session map is persisted as well.
 *
 * **It stores a HASH, never a usable token.** A room token is a credential, and
 * a credential written to disk is a credential that can be read off disk — by
 * anything on the machine, and by anything that later copies the directory. The
 * file holds `sha256(token)`, requests are hashed and looked up, and the file
 * is therefore useless to whoever reads it. That is the same reasoning as not
 * storing a password, applied to the one secret this app issues.
 *
 * ## What is deliberately NOT persisted
 *
 * The live message and the floor. A message half-written when the process died
 * is not a message: restoring one would attribute to somebody words they never
 * finished saying, and restoring a floor holder would leave a room permanently
 * busy waiting for an agent that no longer exists.
 */
import { createHash } from 'node:crypto';
import { FileSessionStore, type JsonObject } from '@particle-academy/prism-harness';
import type { RoomSnapshot } from './room.js';

/** What a token grants. */
export interface StoredSession {
  readonly roomId: string;
  readonly participantId: string;
}

const INDEX = 'rooms:index';
const roomKey = (id: string): string => `room:${id}`;
const sessionKey = (hash: string): string => `session:${hash}`;

/**
 * Hash a room token.
 *
 * Plain SHA-256 with no salt, deliberately: the token is 32 bytes of CSPRNG
 * output, so there is no dictionary to resist and a per-token salt would buy
 * nothing while adding a second thing to store and keep in step. Salting
 * protects low-entropy secrets; this is not one.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class RoomStore {
  readonly #store: FileSessionStore;

  constructor(directory: string) {
    this.#store = new FileSessionStore(directory);
  }

  async saveRoom(snapshot: RoomSnapshot): Promise<void> {
    // Cast through JsonObject because a RoomSnapshot IS json -- readonly arrays
    // of plain records -- but TypeScript cannot see that through the readonly
    // modifiers, and widening the snapshot type to satisfy the store would make
    // the domain type worse to serve the storage layer.
    await this.#store.put(roomKey(snapshot.id), snapshot as unknown as JsonObject);

    // The store has get/put/forget and no way to enumerate, so the set of room
    // ids is kept as its own record. Written AFTER the room, so a crash between
    // the two leaves an unlisted room rather than an index pointing at nothing:
    // one loses a room, the other makes startup fail.
    const index = await this.#roomIds();
    if (!index.includes(snapshot.id)) {
      await this.#store.put(INDEX, { ids: [...index, snapshot.id] });
    }
  }

  async loadRooms(): Promise<readonly RoomSnapshot[]> {
    const snapshots: RoomSnapshot[] = [];

    for (const id of await this.#roomIds()) {
      const raw = await this.#store.get(roomKey(id));
      // A missing or malformed record is SKIPPED rather than thrown on. One
      // unreadable room must not stop the others coming back, and a startup
      // that dies on a corrupt file is a restart that never completes.
      if (isRoomSnapshot(raw)) snapshots.push(raw);
    }

    return snapshots;
  }

  async saveSession(token: string, session: StoredSession): Promise<void> {
    await this.#store.put(sessionKey(hashToken(token)), { ...session });
  }

  /** Resolve a token, or null. The token itself is never compared to anything stored. */
  async readSession(token: string): Promise<StoredSession | null> {
    const raw = await this.#store.get(sessionKey(hashToken(token)));
    if (raw === null) return null;
    return typeof raw.roomId === 'string' && typeof raw.participantId === 'string'
      ? { roomId: raw.roomId, participantId: raw.participantId }
      : null;
  }

  async #roomIds(): Promise<readonly string[]> {
    const raw = await this.#store.get(INDEX);
    const ids = raw?.ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }
}

/**
 * Shape-check a stored room.
 *
 * `Room.restore` trusts what it is given, so this is where a corrupt file is
 * caught. It checks structure, not content: the snapshot came from this app's
 * own directory under the user's own account, and the realistic failure is a
 * truncated write rather than a forged roster.
 */
function isRoomSnapshot(value: Record<string, unknown> | null): value is RoomSnapshot & Record<string, unknown> {
  if (value === null) return false;
  return (
    typeof value.id === 'string' &&
    (value.question === null || typeof value.question === 'string') &&
    Array.isArray(value.participants) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.votes)
  );
}
