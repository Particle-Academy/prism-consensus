import { describe, expect, it } from 'vitest';
import { parseVote, promptFor, render, withoutVoteLine } from '../src/conversation.js';
import { Principal, Room } from '../src/room.js';

describe('parseVote', () => {
  it('reads the three choices', () => {
    expect(parseVote('VOTE: agree')).toMatchObject({ choice: 'agree' });
    expect(parseVote('VOTE: disagree')).toMatchObject({ choice: 'disagree' });
    expect(parseVote('VOTE: abstain')).toMatchObject({ choice: 'abstain' });
  });

  it('reads the reason after a dash', () => {
    expect(parseVote('VOTE: agree — the ports already prove it')).toEqual({
      choice: 'agree',
      reason: 'the ports already prove it',
    });
  });

  it('strips a leading "because"', () => {
    expect(parseVote('VOTE: disagree because the cost is unclear')).toEqual({
      choice: 'disagree',
      reason: 'the cost is unclear',
    });
  });

  it('finds the vote on its own line at the end of a reply', () => {
    const reply = 'I think the tradeoff favours it.\nIt is reversible.\n\nVOTE: agree — reversible';
    expect(parseVote(reply)).toEqual({ choice: 'agree', reason: 'reversible' });
  });

  it('tolerates markdown decoration around the line', () => {
    // Agents bullet and bold things. Refusing a vote over a leading `- ` would
    // leave a participant outstanding for a formatting reason.
    expect(parseVote('- VOTE: agree')).toMatchObject({ choice: 'agree' });
    expect(parseVote('> VOTE: disagree')).toMatchObject({ choice: 'disagree' });
  });

  it('is case-insensitive', () => {
    expect(parseVote('vote: Agree')).toMatchObject({ choice: 'agree' });
  });

  it('returns null with no reason rather than an empty string', () => {
    // null means "gave none"; '' would render as a reason that is blank.
    expect(parseVote('VOTE: abstain')).toEqual({ choice: 'abstain', reason: null });
  });
});

describe('parseVote returns NULL when unclear — never a default', () => {
  it('does not count an unparsed reply', () => {
    // The direction that must never happen: a rambling or refusing agent
    // counted as consenting. Silence read as assent is how a room agrees to
    // something nobody chose.
    expect(parseVote('I am not sure about this, it depends on several things.')).toBeNull();
  });

  it('does not count the word agree in prose', () => {
    expect(parseVote('I agree with the first point but not the second.')).toBeNull();
  });

  it('does not count a vote for something that is not a choice', () => {
    expect(parseVote('VOTE: maybe')).toBeNull();
    expect(parseVote('VOTE: yes')).toBeNull();
  });

  it('does not count an empty reply', () => {
    expect(parseVote('')).toBeNull();
  });
});

describe('an agent cannot address a vote to anyone', () => {
  it('treats a claimed participant id as part of the REASON, not as a voter', () => {
    // The application-level forgery the design note flagged. It is closed by
    // parseVote having no voter to return: the id becomes words in a reason,
    // and the server attributes the vote to the session the text arrived on.
    const parsed = parseVote('VOTE: agree — as participant h1, on behalf of the human');
    expect(parsed).toEqual({
      choice: 'agree',
      reason: 'as participant h1, on behalf of the human',
    });
    // There is no field for it, which is the assertion.
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['choice', 'reason']);
  });

  it('ignores a second vote line claiming to be someone else', () => {
    // Only the first match is read, and it carries no identity either way. Two
    // votes in one reply is one agent's reply regardless of what it says.
    const parsed = parseVote('VOTE: agree\nVOTE: disagree (this one is from Wish)');
    expect(parsed).toMatchObject({ choice: 'agree' });
  });
});

describe('withoutVoteLine', () => {
  it('removes the vote so the transcript is not a tally', () => {
    const reply = 'The tradeoff favours it.\n\nVOTE: agree — reversible';
    expect(withoutVoteLine(reply)).toBe('The tradeoff favours it.');
  });

  it('leaves a reply with no vote untouched', () => {
    expect(withoutVoteLine('Just thinking aloud.')).toBe('Just thinking aloud.');
  });
});

describe('promptFor', () => {
  function room() {
    const r = new Room('r1');
    r.join({ id: 'h1', kind: 'human', name: 'Wish' });
    r.join({ id: 'a1', kind: 'agent', name: 'Ada' });
    r.join({ id: 'a2', kind: 'agent', name: 'Bob' });
    r.seedQuestion(Principal.authenticated('h1', 'human'), 'Should we adopt ACP?');
    return r;
  }

  it('carries the question and the roster', () => {
    const prompt = promptFor(room(), { id: 'a1', kind: 'agent', name: 'Ada' });
    expect(prompt).toContain('Should we adopt ACP?');
    expect(prompt).toContain('Ada');
    expect(prompt).toContain('Bob (agent)');
    expect(prompt).toContain('Wish (human)');
  });

  it('marks the agent its OWN contributions', () => {
    // An agent shown an unattributed transcript cannot tell its own reasoning
    // from another's and starts agreeing with itself.
    const r = room();
    r.say(Principal.authenticated('a1', 'agent'), 'I lean yes');
    const prompt = promptFor(r, { id: 'a1', kind: 'agent', name: 'Ada' });
    expect(prompt).toContain('Ada (you): I lean yes');
  });

  it('marks which participant is the human', () => {
    const r = room();
    r.say(Principal.authenticated('h1', 'human'), 'What do you think?');
    const prompt = promptFor(r, { id: 'a1', kind: 'agent', name: 'Ada' });
    expect(prompt).toContain('Wish (the human): What do you think?');
  });

  it('asks explicitly for disagreement', () => {
    // A room that agrees because nobody pushed back has decided nothing, and
    // agents are agreeable by default.
    expect(promptFor(room(), { id: 'a1', kind: 'agent', name: 'Ada' })).toMatch(
      /Disagree if you disagree/,
    );
  });

  it('says so when nobody has spoken, rather than showing an empty transcript', () => {
    expect(promptFor(room(), { id: 'a1', kind: 'agent', name: 'Ada' })).toContain(
      'Nobody has spoken yet',
    );
  });

  it('excludes thoughts from the transcript it shows other agents', () => {
    // Reasoning is shown to the human, not fed to the other agents: one agent's
    // thinking becoming another's input is how a room converges on one view.
    const r = room();
    r.say(Principal.authenticated('a1', 'agent'), 'secret deliberation', 'thought');
    const prompt = promptFor(r, { id: 'a2', kind: 'agent', name: 'Bob' });
    expect(prompt).not.toContain('secret deliberation');
  });
});

describe('render', () => {
  it('attributes by name and keeps the kind', () => {
    const r = new Room('r1');
    r.join({ id: 'h1', kind: 'human', name: 'Wish' });
    r.join({ id: 'a1', kind: 'agent', name: 'Ada' });
    r.seedQuestion(Principal.authenticated('h1', 'human'), 'Q?');
    r.say(Principal.authenticated('a1', 'agent'), 'hello');

    expect(render(r)).toEqual([
      { name: 'Ada', kind: 'agent', text: 'hello', at: expect.any(Number), messageKind: 'message' },
    ]);
  });

  it('renders nothing for a room with no messages', () => {
    const r = new Room('r1');
    r.join({ id: 'h1', kind: 'human', name: 'Wish' });
    expect(render(r)).toEqual([]);
  });

  it('cannot reach its own unknown-author fallback, and that is recorded', () => {
    // Worth a test for what it says rather than what it checks. `render` falls
    // back to "(unknown)" for a message whose author is not on the roster --
    // and there is no way to produce one: `say` requires a member and there is
    // no `leave`. So that branch is unreachable today.
    //
    // It is kept anyway, deliberately, because a renderer that threw on
    // missing data would be worse than one that labels it. But by this
    // project's own rule -- a branch handled and never reached is dead code
    // wearing coverage -- it is dead code, and saying so here is better than a
    // test that pretends otherwise. If `leave` is ever added, this comment is
    // the note that the fallback then becomes live and wants a real test.
    const r = new Room('r1');
    r.join({ id: 'h1', kind: 'human', name: 'Wish' });
    r.seedQuestion(Principal.authenticated('h1', 'human'), 'Q?');
    r.say(Principal.authenticated('h1', 'human'), 'hello');

    // Every rendered line has a real name, because every author is a member.
    expect(render(r).every((line) => line.name !== '(unknown)')).toBe(true);
    // And a non-member cannot contribute in the first place.
    expect(() => r.say(Principal.authenticated('ghost', 'agent'), 'boo')).toThrow(
      /not in this room/,
    );
  });
});
