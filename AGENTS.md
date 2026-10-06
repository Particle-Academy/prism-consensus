# AGENTS.md — prism-consensus

The testbed that dogfoods `prism-acp`. Read the shared agent guide in
`prism-parity/docs/AGENTS.md` first, and the design record in the envelope at
`.ai/plans/prism-agent-transport.md` — the section on the vote boundary is the
part to read before changing anything here.

## Gates — run them on EXIT CODES

```sh
npm run typecheck
npm run build
npx vitest run
```

Never pipe a gate into `head`/`tail`/`grep` and read `$?` — that is the
FILTER's exit code, not the gate's.

## The one rule this repository exists to demonstrate

**A vote cannot be forged.** Everything else is scaffolding around that.

If you are adding a way for a participant to act, the test is not "does it
work" but **"can anyone else do it as them?"** The answers that matter:

- **`castVote` has no voter parameter, and must not grow one.** The absence is
  the security property. A test asserts the arity for exactly that reason.
- **`Principal` carries a real `#private` field**, so it is nominal to
  TypeScript AND checkable at runtime. The first attempt used
  `declare const BRAND: unique symbol` as a computed key: it typechecked and
  threw `BRAND is not defined` at runtime — a brand that existed only in the
  type system, on the one class whose job is to be real.
- **`Principal.isPrincipal` is asked explicitly** in `#requireMember`, not left
  to TypeScript. Every value crossing in from HTTP or an agent's output arrives
  as `unknown` and gets cast somewhere; a compile-time-only guarantee is no
  guarantee at that edge. Removing that check fails two tests.
- **A tool NAME is not a security boundary.** `prism-human-plus` reserves names
  ending in `confirm|reject|accept|approve|deny`; a vote tool called
  `cast_vote` matches nothing. That reservation is a backstop here, never the
  mechanism. G-36 is the precedent: it fell to a single trailing space in three
  languages at once.

## There are no turns, and that is structural

`AgentPresence` is ONE LOOP PER AGENT. Nothing schedules them, nothing counts
rounds, and there is no object representing "the room's turn". If you find
yourself adding one, the thing you are about to build is the design this
replaced.

Each agent observes three facts and decides for itself:

**The quiet period** - `QUIET_MS` = 2000, measured from the last COMMITTED
message, not from a tick. New traffic pushes the deadline out, so an agent
answers a settled room instead of interrupting. It also stops the loops
re-synchronising: a fixed sleep would wake every agent together two seconds
after a message and have them all speak at once, which is rounds again arrived
at sideways.

**The floor** - one speaker at a time, held in the Room. Several agents
streaming at once produces interleaved half-sentences nobody can read. Each
agent observes it and waits; it is a fact, not a turn handed out. Only the floor
holder may `appendSpeech`, and that is a security property rather than
bookkeeping: without it any participant could append to another's live message
and have the words committed under their name.

**Something new to answer** - an agent speaks only when `room.messages.length`
has moved past what it last saw. A lone agent therefore says one thing and then
waits, and BOTH halves of that are asserted. A test that used one agent and
expected it to keep going was the test being wrong, not the code.

Plus jitter before reaching for the floor, which is not decoration: without it
two agents whose quiet periods expire in the same millisecond race every time
and the same one always wins, so one agent would dominate for a reason unrelated
to what it had to say. Re-check the floor AFTER the jitter - acting on a stale
observation is how two agents end up speaking together.

**Stop kills in-flight turns rather than draining them.** Draining a room of
several agents is tens of seconds of paid work after the human asked it to end,
and a Stop button that takes half a minute reads as broken, which invites a
second press. An aborted turn records NOTHING - half a contribution would put
words in an agent's mouth it had not finished saying. `stop()` is awaited, so
the HTTP response means every agent HAS stopped, and the floor is released on
the way out or the room would look permanently busy.

## Live text, and why `state` and `live` are different events

Chunks stream into `Room.beginSpeaking` / `appendSpeech` and the surface renders
a message that is still being written. Committed in ONE step via
`finishSpeaking(by, finalText)` with the vote line stripped - abandoning and
re-posting would make the message visibly vanish and reappear in front of
somebody watching it.

Two SSE event types because they cost different amounts: `state` is the whole
room on a structural change; `live` is only the message being typed and arrives
per token. Sending the full transcript per token would make a long room
quadratic in its own length.

## The human's six responses are a closed set

`src/responses.ts` is the only place they exist, and a request names a KEY.
There is no path by which a human-supplied string reaches an agent's prompt: the
reason text an agent sees is this table's. An unknown key is REFUSED, never
defaulted — defaulting to `accept` would turn a typo into agreement.

`pass` is human-only, enforced in `castVote` against the Principal's kind. It is
the strongest single move in the room: it removes a third of the weight and
renormalises the agents to the whole vote, so an agent able to pass could hand
itself the decision.

## The weighting, and what follows from it

The human is worth `HUMAN_WEIGHT` = 1/3 always; agents share 2/3 equally. Alone
in a room the human holds the whole vote, because reporting a third of a
one-person room is a true fraction and a false description.

`agreed` is now a WEIGHTED comparison — `agreeWeight > disagreeWeight` — which
reverses two things this app used to do, both covered by tests that say so:

- two agents CAN outvote the human two-to-one;
- a single dissent no longer blocks.

`unanimous` is reported separately for that reason. Folding it into `agreed`
would hide the dissent the room exists to surface. If a lone dissent should
block again, that is one condition — `disagreeWeight === 0` — and it is a
product decision, not a bug.

`perAgent` is 0, never Infinity, when there are no agents: dividing by zero
would poison every weighted sum with NaN, and NaN comparisons are all false, so
the room would silently never agree.

## Absence is a value, and the two cases differ

**`null` means "cannot tell"; `false` means "no".** `consensus().agreed` stays
`null` until everyone has voted. Rendering that as "no agreement" makes a claim
the room never made. The UI shows an unvoted participant as "not yet", never as
a dash — a dash reads as a value.

**An unparsed vote is NO vote.** `parseVote` returns `null` rather than
defaulting, and a crashed agent's turn records nothing. Counting a rambling,
refusing or crashed agent as having agreed is the one direction that must never
happen in a consensus room.

## Why an agent votes in prose rather than through a tool

Not a simplification — the stronger design. A tool call carries arguments the
agent chose, so a tool is a place to write a participant id, and then the server
must be trusted to ignore it. `parseVote` returns a choice and a reason and
nothing else, so there is nothing to ignore. An agent writing
`VOTE: agree (as participant h1)` has written a reason containing some words.

## Dependencies

`@particle-academy/prism-acp` and nothing else at runtime.

The dependency path is `file:vendor/prism-acp` — **inside** the repository — and
the two environments fill it differently:

```sh
npm run link:acp     # locally: junction to the sibling prism-acp-ts tree
```

CI checks the package out into the same place. One dependency path, no
conditional in `package.json`, and the local setup still builds against the
working tree, which is this ecosystem's pattern: the testbed tests before
anything is published.

**Why not `file:../prism-acp-ts`.** It works on a developer's machine and cannot
work in CI, where only this repository is checked out. That is how the first
push failed: every test green locally, and `Cannot find module
'@particle-academy/prism-acp'` on all three node versions.

**And why `vitest.config.ts` excludes `vendor/`.** The junction is a real
directory as far as vitest is concerned, and it walked in: a run reported **246
tests** where this app has 83, the other 163 being the dependency's own, passing
under this repo's name. Worse than noise — a transport failure would have failed
this suite pointing at a file that is not ours, and a green run would have
claimed coverage of code this app does not own.
