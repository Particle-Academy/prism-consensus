/**
 * A room where several agents and a human discuss a question and vote.
 *
 * The whole point of this app is that **a vote cannot be forged**, so the
 * domain is built around that one property rather than having it added later.
 *
 * ## Why identity is a type and not a field
 *
 * The obvious design takes a `voterId` in the request and records a vote
 * against it. That design lets any participant vote as any other, and nothing
 * reports it: the votes tally, the room reaches consensus, and an agent has
 * carried a decision on its own.
 *
 * So {@link Principal} cannot be constructed from untrusted data. It is minted
 * only by the layer that authenticated a channel — an HTTP request carrying the
 * human's room token, or an ACP session bound to one agent — and
 * {@link Room.castVote} accepts nothing else. The voter is therefore always the
 * channel, never a claim.
 *
 * ## Why a tool name is not the defence
 *
 * `prism-human-plus` reserves actions for the human by matching tool names
 * ending in `confirm | reject | accept | approve | deny`. That reservation is
 * real and it is a BACKSTOP here, not the mechanism: a vote tool named
 * `cast_vote` would not match it at all, and the app would look correct while
 * being wide open. A tool name is chosen by the surface, matched by a regex, and
 * one rename away from being wrong.
 *
 * G-36 is the precedent: that same reservation was defeated in three languages
 * at once by a single trailing space in a name. Anything resting on a name is
 * resting on something a caller controls.
 */

/** Who is in the room. A human and some agents. */
export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  readonly id: string;
  readonly kind: ParticipantKind;
  readonly name: string;
}

export type VoteChoice = 'agree' | 'disagree' | 'abstain';

export interface Vote {
  readonly participantId: string;
  readonly choice: VoteChoice;
  /** Why, in the voter's own words. Optional, because abstaining needs none. */
  readonly reason: string | null;
  readonly at: number;
}

export interface Message {
  readonly participantId: string;
  readonly text: string;
  readonly at: number;
  /** Reasoning content, kept separate because a reader treats it differently. */
  readonly kind: 'message' | 'thought';
}

/**
 * Proof that a channel was authenticated, and who it belongs to.
 *
 * The private brand is the enforcement. `JSON.parse` cannot produce one of
 * these, so no request body, tool argument or agent output can become a
 * Principal however it is shaped — which is what makes impersonation a type
 * error rather than a thing to remember to check.
 */
export class Principal {
  /**
   * A real `#private` field, not a phantom type.
   *
   * The first attempt used `declare const BRAND: unique symbol` as a computed
   * key, which typechecks and then throws `BRAND is not defined` at runtime --
   * a brand that existed only in the type system, on the one class whose job is
   * to be real. A `#` field is nominal to TypeScript AND present at runtime, so
   * `#isPrincipal` below can actually ask.
   */
  readonly #brand = true;
  readonly participantId: string;
  readonly kind: ParticipantKind;

  /**
   * True only for a genuine Principal.
   *
   * `#brand in value` is the brand check a private field makes possible, and it
   * is total: no object literal, `JSON.parse` result or agent output can carry
   * a `#` field, so there is nothing to spoof rather than something to detect.
   */
  static isPrincipal(value: unknown): value is Principal {
    return typeof value === 'object' && value !== null && #brand in value;
  }

  private constructor(participantId: string, kind: ParticipantKind) {
    this.participantId = participantId;
    this.kind = kind;
  }

  /**
   * Mint a Principal. Call this ONLY from a layer that has authenticated the
   * channel — never from request parsing.
   *
   * Deliberately not named `fromRequest` or similar: there is no safe way to
   * build one of these from input, and a name suggesting otherwise would invite
   * exactly the mistake this type exists to prevent.
   */
  static authenticated(participantId: string, kind: ParticipantKind): Principal {
    if (participantId.length === 0) throw new Error('a Principal needs a participant id');
    return new Principal(participantId, kind);
  }
}

export interface Tally {
  readonly agree: number;
  readonly disagree: number;
  readonly abstain: number;
  /** Participants who have not voted yet. */
  readonly outstanding: readonly string[];
}

export interface ConsensusState {
  readonly reached: boolean;
  /**
   * Null until every participant has voted.
   *
   * Null means "cannot tell yet", NOT "no". The two are different facts and
   * collapsing them is the bug: a UI that renders an undecided room as "no
   * consensus" has made a claim the room has not made.
   */
  readonly agreed: boolean | null;
  readonly tally: Tally;
}

export class RoomError extends Error {}

export class Room {
  readonly id: string;
  /** The question the human seeded. Null until they do. */
  question: string | null = null;

  readonly #participants = new Map<string, Participant>();
  readonly #votes = new Map<string, Vote>();
  readonly #messages: Message[] = [];

  constructor(id: string) {
    this.id = id;
  }

  get participants(): readonly Participant[] {
    return [...this.#participants.values()];
  }

  get messages(): readonly Message[] {
    return [...this.#messages];
  }

  get votes(): readonly Vote[] {
    return [...this.#votes.values()];
  }

  join(participant: Participant): void {
    if (this.#participants.has(participant.id)) {
      throw new RoomError(`participant ${participant.id} is already in the room`);
    }
    // One human per room. Two would make "the human's vote" ambiguous, and the
    // reservation this app demonstrates is about a single human surface.
    if (participant.kind === 'human' && this.participants.some((p) => p.kind === 'human')) {
      throw new RoomError('the room already has a human');
    }
    this.#participants.set(participant.id, participant);
  }

  /**
   * Seed the question. Only the human may.
   *
   * Checked against the Principal's kind, not against anything in the call. An
   * agent that could set the question could steer the whole room by restating
   * it mid-discussion.
   */
  seedQuestion(by: Principal, question: string): void {
    this.#requireMember(by);
    if (by.kind !== 'human') {
      throw new RoomError('only the human may seed the question');
    }
    if (question.trim().length === 0) throw new RoomError('the question must not be empty');
    if (this.question !== null) throw new RoomError('the question is already set');
    this.question = question;
  }

  say(by: Principal, text: string, kind: Message['kind'] = 'message'): Message {
    this.#requireMember(by);
    // The participantId comes from the Principal. There is no parameter for it,
    // which is the point: a caller cannot attribute a message to someone else
    // even by accident.
    const message: Message = { participantId: by.participantId, text, at: Date.now(), kind };
    this.#messages.push(message);
    return message;
  }

  /**
   * Record a vote, attributed to the authenticated channel.
   *
   * There is deliberately NO participantId parameter. That absence is the
   * security property: the only way to vote as someone is to hold their
   * authenticated channel.
   */
  castVote(by: Principal, choice: VoteChoice, reason: string | null = null): Vote {
    this.#requireMember(by);
    if (this.question === null) {
      throw new RoomError('nobody can vote before the question is seeded');
    }

    const existing = this.#votes.get(by.participantId);
    if (existing !== undefined) {
      // Changing a vote is legitimate -- a discussion is supposed to move
      // people -- but it must be visible rather than silent, so the caller is
      // told and the new vote replaces the old with a fresh timestamp.
      this.#votes.delete(by.participantId);
    }

    const vote: Vote = { participantId: by.participantId, choice, reason, at: Date.now() };
    this.#votes.set(by.participantId, vote);
    return vote;
  }

  consensus(): ConsensusState {
    const voted = new Set(this.#votes.keys());
    const outstanding = this.participants
      .map((p) => p.id)
      .filter((id) => !voted.has(id));

    const tally: Tally = {
      agree: this.votes.filter((v) => v.choice === 'agree').length,
      disagree: this.votes.filter((v) => v.choice === 'disagree').length,
      abstain: this.votes.filter((v) => v.choice === 'abstain').length,
      outstanding,
    };

    // `agreed` stays null until everyone has voted, because an incomplete room
    // has not decided anything. Reporting false early would read as "the room
    // disagreed", which is a different and untrue claim.
    if (outstanding.length > 0 || this.#participants.size === 0) {
      return { reached: false, agreed: null, tally };
    }

    // Consensus means nobody dissented. An abstention is not a dissent, but it
    // is not an agreement either -- so a room of all abstentions reaches a
    // decision of `false`, not `true`.
    const agreed = tally.disagree === 0 && tally.agree > 0;
    return { reached: true, agreed, tally };
  }

  #requireMember(principal: Principal): void {
    // Asked explicitly, not left to TypeScript. Every value crossing into this
    // process from HTTP or an agent's output arrives as `unknown` and gets cast
    // somewhere; a compile-time-only guarantee is no guarantee at that edge.
    if (!Principal.isPrincipal(principal)) {
      throw new RoomError('not an authenticated principal — identity cannot come from input');
    }

    const participant = this.#participants.get(principal.participantId);
    if (participant === undefined) {
      throw new RoomError(`${principal.participantId} is not in this room`);
    }
    // A Principal carries the kind the authenticating layer asserted. If it
    // disagrees with the roster, something upstream is confused about who it is
    // talking to, and continuing would attribute an action to the wrong kind of
    // participant.
    if (participant.kind !== principal.kind) {
      throw new RoomError(
        `${principal.participantId} is a ${participant.kind} but presented as a ${principal.kind}`,
      );
    }
  }
}
