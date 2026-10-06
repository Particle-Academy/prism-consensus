import { describe, expect, it } from 'vitest';
import { Principal, Room, RoomError } from '../src/room.js';

const human = () => Principal.authenticated('h1', 'human');
const agentA = () => Principal.authenticated('a1', 'agent');
const agentB = () => Principal.authenticated('a2', 'agent');

function seeded() {
  const room = new Room('r1');
  room.join({ id: 'h1', kind: 'human', name: 'Wish' });
  room.join({ id: 'a1', kind: 'agent', name: 'Agent A' });
  room.join({ id: 'a2', kind: 'agent', name: 'Agent B' });
  room.seedQuestion(human(), 'Should we adopt ACP?');
  return room;
}

describe('a vote cannot be forged — the property this app exists to show', () => {
  it('has NO participantId parameter on castVote', () => {
    // The security property is an absence, so it is asserted as one. If a
    // future signature grows an id parameter, this fails and whoever added it
    // has to read why it was not there.
    //
    // castVote(by, choice, reason) -- three parameters, none of them an id.
    expect(Room.prototype.castVote.length).toBe(2); // `reason` has a default
  });

  it('attributes a vote to the authenticated channel, never to a claim', () => {
    const room = seeded();
    const vote = room.castVote(agentA(), 'agree');
    expect(vote.participantId).toBe('a1');
  });

  it('cannot be tricked by a plain object shaped like a Principal', () => {
    // The forgery an attacker would actually try: JSON that looks like
    // identity. TypeScript refuses it at compile time; this proves the runtime
    // refuses it too, because a compile-time-only guarantee is no guarantee at
    // the edge of a process where JSON arrives.
    const room = seeded();
    const forged = { participantId: 'h1', kind: 'human' } as unknown as Principal;
    expect(() => room.castVote(forged, 'agree')).toThrow();
  });

  it('refuses a Principal whose kind disagrees with the roster', () => {
    // An agent presenting as the human. The roster is the authority on what
    // someone is; a channel asserting otherwise means something upstream is
    // confused about who it is talking to.
    const room = seeded();
    const impostor = Principal.authenticated('a1', 'human');
    expect(() => room.castVote(impostor, 'agree')).toThrow(/presented as a human/);
  });

  it('refuses a participant who is not in the room at all', () => {
    const room = seeded();
    const outsider = Principal.authenticated('zzz', 'agent');
    expect(() => room.castVote(outsider, 'agree')).toThrow(/not in this room/);
  });

  it('refuses a forged principal for SAYING things too, not just voting', () => {
    // Attribution matters for messages as well: a transcript where an agent can
    // put words in the human's mouth is its own forgery, and it is the one that
    // would steer the vote rather than cast it.
    const room = seeded();
    const forged = { participantId: 'h1', kind: 'human' } as unknown as Principal;
    expect(() => room.say(forged, 'I agree with everything')).toThrow();
  });

  it('attributes every message to its own channel', () => {
    const room = seeded();
    room.say(agentA(), 'I think yes');
    room.say(human(), 'Say more');
    expect(room.messages.map((m) => m.participantId)).toEqual(['a1', 'h1']);
  });
});

describe('only the human seeds the question', () => {
  it('refuses an agent', () => {
    // An agent that could set the question could steer the room by restating it
    // mid-discussion, which is a subtler takeover than casting a vote.
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    room.join({ id: 'a1', kind: 'agent', name: 'A' });
    expect(() => room.seedQuestion(agentA(), 'Should we do what I want?')).toThrow(
      /only the human/,
    );
    expect(room.question).toBeNull();
  });

  it('accepts the human', () => {
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    room.seedQuestion(human(), 'Should we adopt ACP?');
    expect(room.question).toBe('Should we adopt ACP?');
  });

  it('refuses an empty question', () => {
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    expect(() => room.seedQuestion(human(), '   ')).toThrow();
  });

  it('refuses a second question', () => {
    // Re-seeding mid-discussion would invalidate every vote already cast while
    // leaving them in the tally.
    const room = seeded();
    expect(() => room.seedQuestion(human(), 'Different question')).toThrow(/already set/);
  });
});

describe('voting order and timing', () => {
  it('refuses a vote before the question is seeded', () => {
    // A vote on nothing is not a vote, and recording one would let an agent
    // pre-commit the room before the human has asked anything.
    const room = new Room('r1');
    room.join({ id: 'a1', kind: 'agent', name: 'A' });
    expect(() => room.castVote(agentA(), 'agree')).toThrow(/before the question/);
  });

  it('lets a participant change their vote, replacing rather than adding', () => {
    // A discussion is supposed to move people. What must not happen is one
    // participant counting twice.
    const room = seeded();
    room.castVote(agentA(), 'disagree');
    room.castVote(agentA(), 'agree');
    expect(room.votes).toHaveLength(1);
    expect(room.votes[0]?.choice).toBe('agree');
  });
});

describe('consensus', () => {
  it('is UNDECIDED, not false, while anyone has not voted', () => {
    // null means "cannot tell yet"; false means "the room disagreed". A UI that
    // renders the first as the second has made a claim the room has not made.
    const room = seeded();
    room.castVote(human(), 'agree');
    const state = room.consensus();
    expect(state.reached).toBe(false);
    expect(state.agreed).toBeNull();
    expect(state.tally.outstanding).toEqual(['a1', 'a2']);
  });

  it('reaches agreement when everyone agrees', () => {
    const room = seeded();
    room.castVote(human(), 'agree');
    room.castVote(agentA(), 'agree');
    room.castVote(agentB(), 'agree');
    expect(room.consensus()).toMatchObject({ reached: true, agreed: true });
  });

  it('a single dissent NO LONGER blocks, because the vote is weighted', () => {
    // A deliberate consequence of weighting the human at a third, recorded
    // because it reverses what this app did before and is easy to assume
    // otherwise: the decision is now a weighted comparison, so human-agree
    // (1/3) plus one agent-agree (1/3) beats one agent-disagree (1/3).
    //
    // The dissent is not hidden -- `unanimous` reports it separately. Folding
    // the two into one boolean is what would hide it.
    const room = seeded();
    room.castVote(human(), 'agree');
    room.castVote(agentA(), 'agree');
    room.castVote(agentB(), 'disagree');

    const state = room.consensus();
    expect(state).toMatchObject({ reached: true, agreed: true, unanimous: false });
    expect(state.tally.agreeWeight).toBeCloseTo(2 / 3);
    expect(state.tally.disagreeWeight).toBeCloseTo(1 / 3);
  });

  it('the agents CAN outvote the human two-to-one', () => {
    // The arithmetic of a one-third human share, asserted rather than left
    // implicit. One agent raised exactly this objection unprompted in the first
    // live run: "a majority rule would let agents overrule the person the
    // decision is for". With this weighting, it can.
    const room = seeded();
    room.castVote(human(), 'disagree');
    room.castVote(agentA(), 'agree');
    room.castVote(agentB(), 'agree');

    expect(room.consensus()).toMatchObject({ reached: true, agreed: true, unanimous: false });
  });

  it('the human alone can block two agents when one of them dissents', () => {
    // 1/3 disagree from the human plus 1/3 disagree from an agent outweighs a
    // single 1/3 agreement, so the human is not powerless -- they are one third.
    const room = seeded();
    room.castVote(human(), 'disagree');
    room.castVote(agentA(), 'disagree');
    room.castVote(agentB(), 'agree');

    expect(room.consensus()).toMatchObject({ reached: true, agreed: false });
  });

  it('does not count an abstention as agreement', () => {
    // All-abstain reaches a decision of false, not true. "Nobody objected" is
    // not the same as "everybody agreed", and treating silence as assent is how
    // a room agrees to something nobody chose.
    const room = seeded();
    room.castVote(human(), 'abstain');
    room.castVote(agentA(), 'abstain');
    room.castVote(agentB(), 'abstain');
    expect(room.consensus()).toMatchObject({ reached: true, agreed: false });
  });

  it('weights the human at exactly one third, whatever the agent count', () => {
    // "Always" is the requirement. With five agents a one-vote-each room would
    // leave the human a sixth; here they keep a third and the five share the
    // rest.
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    for (let n = 1; n <= 5; n++) room.join({ id: `a${n}`, kind: 'agent', name: `A${n}` });

    const weights = room.weights();
    expect(weights.human).toBeCloseTo(1 / 3);
    expect(weights.perAgent).toBeCloseTo(2 / 15);
    // And the shares account for the whole vote, with nothing unassigned.
    expect(weights.human + weights.perAgent * 5).toBeCloseTo(1);
  });

  it('gives the human the whole vote when there are no agents', () => {
    // Zero rather than two thirds unassigned: an unassigned share would make
    // agreement arithmetically impossible in a room where the only participant
    // agreed.
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    room.seedQuestion(human(), 'Q?');
    room.castVote(human(), 'agree');
    expect(room.weights().human).toBeCloseTo(1);
    expect(room.consensus()).toMatchObject({ reached: true, agreed: true });
  });
});

describe('pass — the human hands the decision to the agents', () => {
  it('removes the human third and renormalises the agents to the whole vote', () => {
    const room = seeded();
    room.castVote(human(), 'pass');
    expect(room.weights().human).toBe(0);
    expect(room.weights().perAgent).toBeCloseTo(1 / 2);
  });

  it('counts the human as HAVING voted, so the room can still decide', () => {
    // Passing is a decision about who decides, not a silence. Leaving the human
    // outstanding would mean a passed room could never reach a conclusion.
    const room = seeded();
    room.castVote(human(), 'pass');
    room.castVote(agentA(), 'agree');
    room.castVote(agentB(), 'agree');

    const state = room.consensus();
    expect(state.tally.outstanding).toEqual([]);
    expect(state).toMatchObject({ reached: true, agreed: true });
    expect(state.tally.humanPassed).toBe(true);
  });

  it('lets a single agent decide a passed room', () => {
    const room = seeded();
    room.castVote(human(), 'pass');
    room.castVote(agentA(), 'agree');
    room.castVote(agentB(), 'disagree');
    // Half each once the human's third is removed, so a tie is not an
    // agreement: agreeWeight must EXCEED disagreeWeight.
    expect(room.consensus()).toMatchObject({ reached: true, agreed: false });
  });

  it('is refused for an agent — only the human may pass', () => {
    // Passing is the strongest single move in the room: it removes a third of
    // the weight and renormalises the agents to the whole vote. An agent able
    // to pass could hand itself the decision.
    const room = seeded();
    expect(() => room.castVote(agentA(), 'pass')).toThrow(/only the human may pass/);
  });

  it('differs from abstain, which keeps the weight parked on neither side', () => {
    // The distinction worth having: abstaining can make agreement impossible,
    // passing takes the third off the table so the agents can decide.
    const abstained = seeded();
    abstained.castVote(human(), 'abstain');
    expect(abstained.weights().human).toBeCloseTo(1 / 3);

    const passed = seeded();
    passed.castVote(human(), 'pass');
    expect(passed.weights().human).toBe(0);
  });

  it('counts an abstention as neither agree nor disagree in the tally', () => {
    const room = seeded();
    room.castVote(human(), 'agree');
    room.castVote(agentA(), 'abstain');
    room.castVote(agentB(), 'agree');
    const { tally, agreed } = room.consensus();
    expect(tally).toMatchObject({ agree: 2, disagree: 0, abstain: 1, outstanding: [] });
    expect(agreed).toBe(true);
  });

  it('is undecided for an empty room rather than vacuously agreed', () => {
    // A room with no participants has agreed to nothing. "Everyone voted" is
    // trivially true of nobody, and a naive implementation reports consensus.
    const room = new Room('r1');
    expect(room.consensus()).toMatchObject({ reached: false, agreed: null });
  });
});

describe('the roster', () => {
  it('allows only one human', () => {
    // Two would make "the human's vote" ambiguous, and the reservation this app
    // demonstrates is about a single human surface.
    const room = new Room('r1');
    room.join({ id: 'h1', kind: 'human', name: 'Wish' });
    expect(() => room.join({ id: 'h2', kind: 'human', name: 'Someone' })).toThrow(
      /already has a human/,
    );
  });

  it('allows several agents', () => {
    const room = new Room('r1');
    room.join({ id: 'a1', kind: 'agent', name: 'A' });
    room.join({ id: 'a2', kind: 'agent', name: 'B' });
    room.join({ id: 'a3', kind: 'agent', name: 'C' });
    expect(room.participants).toHaveLength(3);
  });

  it('refuses a duplicate id', () => {
    const room = new Room('r1');
    room.join({ id: 'a1', kind: 'agent', name: 'A' });
    expect(() => room.join({ id: 'a1', kind: 'agent', name: 'A again' })).toThrow(RoomError);
  });
});

describe('Principal', () => {
  it('cannot be constructed directly', () => {
    // `new Principal(...)` is a compile error. At runtime the constructor is
    // private only by convention, so the real guarantee is #requireMember
    // rejecting anything the roster does not back -- which is why the forged
    // -object tests above matter more than this one.
    expect(() => Principal.authenticated('', 'human')).toThrow();
  });

  it('carries the id and kind it was minted with', () => {
    const p = Principal.authenticated('h1', 'human');
    expect(p.participantId).toBe('h1');
    expect(p.kind).toBe('human');
  });
});
