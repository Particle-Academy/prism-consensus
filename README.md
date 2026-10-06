# prism-consensus

A room where several agents and a human discuss one question and vote for
consensus. It is the testbed that **dogfoods `prism-acp`**: each agent runs in
its own session over the agent CLI you have already signed in to, with no API
key and no third-party adapter.

```sh
npm ci && npm start     # http://127.0.0.1:8099
```

Open a room, add a couple of agents, seed a question, run a round. The agents
argue, everyone votes, and the room tells you whether it agreed.

## What it is actually for

Three of its requirements were written down as **transport** requirements before
any of it existed, because discovering them afterwards would have meant
rewriting the transport:

- **Several sessions at once.** A room holds several agents, each its own
  process with its own in-flight turn. A design that assumed one session works
  perfectly for the first agent and has to be taken apart for the second.
- **The human is a participant, not the operator.** They vote alongside the
  agents, so "who said this" is a first-class property of every contribution
  rather than an inference from which pipe it arrived on.
- **A vote cannot be forged.** An agent that can cast the human's vote has
  defeated the entire point.

## How the vote is protected, and how it is not

**Not by a tool name.** `prism-human-plus` reserves human-only actions by
matching names ending in `confirm | reject | accept | approve | deny`. A vote
tool called `cast_vote` would not match that at all — the app would look
correct, the votes would tally, and any agent could carry a decision. A tool
name is chosen by the surface, matched by a regex, and one rename from being
wrong.

So instead:

- **Identity is a type, not a field.** `Principal` cannot be built from
  untrusted data — it carries a real `#private` field, so no request body, tool
  argument or agent output can become one however it is shaped.
- **`castVote` has no voter parameter.** That absence *is* the security
  property: the only way to vote as someone is to hold their authenticated
  channel. A request claiming `participantId` is simply not read.
- **An agent votes in prose**, and the server attributes it to the session the
  prose arrived on. A tool call would carry arguments the agent chose; here
  there is nothing to ignore, because the parser returns a choice and a reason
  and nothing else.
- **Two ingress paths.** The human arrives over HTTP with a room token held in
  an `HttpOnly` cookie, never shown to an agent. An agent arrives through its
  own session. Neither can mint the other's identity.

## Two deliberate choices about absence

**An unparsed vote is no vote.** A rambling or refusing agent stays
`outstanding` rather than being counted as consenting. Silence read as assent is
how a room agrees to something nobody chose.

**`agreed` is `null` until everyone has voted**, not `false`. Those are
different facts: one says the room has not decided, the other says it decided
against. A UI that renders the first as the second has made a claim the room
never made.

## License

MIT
