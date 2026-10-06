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

import { confusable } from './names.js';

/** Who is in the room. A human and some agents. */
export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  readonly id: string;
  readonly kind: ParticipantKind;
  readonly name: string;
}

/**
 * `pass` is HUMAN-ONLY, and it is not the same as `abstain`.
 *
 * - `abstain` — "I have voted, and my weight counts for neither side."
 * - `pass` — "hand this to the agents": the human's weight is REMOVED and the
 *   agents' share is renormalised to the whole vote.
 *
 * Collapsing them would lose a real distinction. Abstaining keeps a third of
 * the weight parked on neither side, which can make agreement impossible to
 * reach; passing takes it off the table so the agents can actually decide.
 */
export type VoteChoice = 'agree' | 'disagree' | 'abstain' | 'pass';

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

/**
 * How much each participant's vote is worth.
 *
 * **The human is always worth exactly one third**, however many agents are in
 * the room, and the agents share the remaining two thirds equally. "Always" is
 * the point: with five agents the human still holds a third, where a
 * one-vote-each room would have left them with a sixth.
 *
 * A consequence worth seeing rather than discovering: two agents at a third
 * each CAN outvote the human two-to-one. That is what this weighting means, and
 * it is the exact objection one agent raised unprompted in the first live run —
 * "a majority rule would let agents overrule the person the decision is for".
 * The weights are reported in the tally so the arithmetic is visible instead of
 * implied.
 *
 * When the human passes, their third is removed and the agents renormalise to
 * the whole vote.
 */
export interface Weights {
  readonly human: number;
  readonly perAgent: number;
}

/** The human's fixed share. */
export const HUMAN_WEIGHT = 1 / 3;

export interface Tally {
  readonly agree: number;
  readonly disagree: number;
  readonly abstain: number;
  /** Weighted sums, which are what the decision is made on. */
  readonly agreeWeight: number;
  readonly disagreeWeight: number;
  readonly abstainWeight: number;
  /** Participants who have not voted yet. */
  readonly outstanding: readonly string[];
  /** True once the human has handed the decision to the agents. */
  readonly humanPassed: boolean;
  readonly weights: Weights;
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
  /**
   * Whether anybody dissented at all, reported SEPARATELY from `agreed`.
   *
   * Once the vote is weighted, `agreed` is a weighted decision and no longer
   * means "everyone was happy". Both facts matter and they can differ: a room
   * can agree on weight while one participant disagreed outright. Folding them
   * into one boolean would hide the dissent that the room is supposed to make
   * visible.
   */
  readonly unanimous: boolean | null;
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

    // A name a reader cannot tell apart from another is an attribution forgery
    // waiting to happen: the transcript every agent reads is labelled by name.
    // Compared in canonical form, so a trailing space, a zero-width character
    // or a Cyrillic look-alike are all the same name -- the narrow fix would
    // have closed the ASCII hole and left three Unicode ones, which is exactly
    // how G-36 happened.
    const clash = this.participants.find((p) => confusable(p.name, participant.name));
    if (clash !== undefined) {
      throw new RoomError(
        `a participant called "${clash.name}" is already here; "${participant.name}" would be indistinguishable`,
      );
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

    // `pass` is the human's alone, and it is the strongest single move in the
    // room: it removes a third of the weight and renormalises the agents to the
    // whole vote. An agent able to pass could hand itself the decision, which
    // is the same defect as an agent casting the human's vote wearing a
    // different name.
    if (choice === 'pass' && by.kind !== 'human') {
      throw new RoomError('only the human may pass');
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

  /**
   * What each participant's vote is worth right now.
   *
   * The human holds {@link HUMAN_WEIGHT} and the agents share the rest. If the
   * human has passed, their share is removed and the agents renormalise to the
   * whole vote — which is what passing means.
   *
   * A room with no agents gives the human everything rather than leaving two
   * thirds unassigned, because an unassigned share would make agreement
   * arithmetically impossible in a room where the only participant agreed.
   */
  weights(): Weights {
    const agents = this.participants.filter((p) => p.kind === 'agent').length;
    const humanPresent = this.participants.some((p) => p.kind === 'human');
    const passed = this.votes.some((v) => v.choice === 'pass');

    // A third only when there is somebody to share the rest with. Alone, the
    // human holds the whole vote: leaving two thirds unassigned would report
    // that they hold a third of a room they are the only member of, which is
    // a true fraction and a false description.
    const human = !humanPresent || passed ? 0 : agents === 0 ? 1 : HUMAN_WEIGHT;
    const agentShare = 1 - human;

    return {
      human,
      // Zero rather than Infinity when there are no agents: dividing by zero
      // here would poison every weighted sum with NaN, and NaN comparisons are
      // all false, so the room would silently never agree.
      perAgent: agents === 0 ? 0 : agentShare / agents,
    };
  }

  consensus(): ConsensusState {
    const voted = new Set(this.#votes.keys());
    const outstanding = this.participants.map((p) => p.id).filter((id) => !voted.has(id));
    const weights = this.weights();
    const kindOf = new Map(this.participants.map((p) => [p.id, p.kind]));

    const weightOf = (participantId: string): number =>
      kindOf.get(participantId) === 'human' ? weights.human : weights.perAgent;

    const sum = (choice: VoteChoice): number =>
      this.votes
        .filter((v) => v.choice === choice)
        .reduce((total, v) => total + weightOf(v.participantId), 0);

    const tally: Tally = {
      agree: this.votes.filter((v) => v.choice === 'agree').length,
      disagree: this.votes.filter((v) => v.choice === 'disagree').length,
      abstain: this.votes.filter((v) => v.choice === 'abstain').length,
      agreeWeight: sum('agree'),
      disagreeWeight: sum('disagree'),
      abstainWeight: sum('abstain'),
      outstanding,
      humanPassed: this.votes.some((v) => v.choice === 'pass'),
      weights,
    };

    // `agreed` stays null until everyone has voted, because an incomplete room
    // has not decided anything. Reporting false early would read as "the room
    // disagreed", which is a different and untrue claim. A passing human HAS
    // voted -- passing is a decision about who decides, not a silence.
    if (outstanding.length > 0 || this.#participants.size === 0) {
      return { reached: false, agreed: null, unanimous: null, tally };
    }

    // The decision is made on WEIGHT, which is what weighting the human's vote
    // means. An abstention sits on neither side, so a room of all abstentions
    // reaches a decision of `false` rather than `true`: "nobody objected" is
    // not "everybody agreed", and reading silence as assent is how a room
    // agrees to something nobody chose.
    const agreed = tally.agreeWeight > tally.disagreeWeight;

    // Reported separately, because once the vote is weighted `agreed` no longer
    // implies nobody dissented -- and the dissent is the thing worth seeing.
    const unanimous = tally.disagree === 0 && tally.agree > 0;

    return { reached: true, agreed, unanimous, tally };
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
