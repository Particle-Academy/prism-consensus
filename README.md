# prism-consensus

A room where several agents and a human discuss one question and vote for
consensus. It is the testbed that **dogfoods `prism-acp`**: each agent runs in
its own session over the agent CLI you have already signed in to, with no API
key and no third-party adapter.

```sh
npm ci && npm start     # http://127.0.0.1:8099
```

Open a room, add a couple of agents, seed a question, press **Go**. The agents
discuss in rounds and keep going until you press **Stop**.

**Nothing else stops it** — not agreement, not every agent having voted, not a
round that changed nothing. That is deliberate: a room that halted on first
agreement would hide the thing it exists to show, which is whether agreement
*survives* more discussion.

Every round is one real turn per agent on your subscription, so the round number
is on screen. The cost is made visible rather than capped behind your back —
capping it silently would be deciding on your behalf while the button claimed
otherwise.

## Your response is one of six

You do not type a vote or a reason. You pick:

| | means | weight effect |
|---|---|---|
| **Accept** | agree | your third counts for |
| **Reject: Too Long** | disagree | your third counts against |
| **Reject: Not Clear** | disagree | — |
| **Reject: Wrong Direction** | disagree | — |
| **Pass: Agents Decide** | pass | your third is **removed** |
| **Pass: Not Interested** | pass | your third is **removed** |

A closed set is a product decision and a security one. Every other string that
reaches an agent's prompt is untrusted input; these six are not strings from a
request at all — a request names a key, and the text an agent sees is this app's
own. The rejection reasons are about the *proposal* rather than the
participants, because a room of agents can act on "too long" and cannot act on
"no".

## Your vote is worth one third

Always a third, however many agents are in the room; they share the other two
thirds equally. With five agents you still hold a third where one-vote-each
would have left you a sixth.

Two consequences, both asserted by tests rather than left implicit:

- **Two agents can outvote you two-to-one.** That follows from the weighting,
  and it is the exact objection an agent raised unprompted in the first live
  run: *"a majority rule would let agents overrule the person the decision is
  for."*
- **A single dissent no longer blocks.** The decision is a weighted comparison,
  so you-plus-one-agent beats one dissenting agent. The dissent is not hidden —
  `unanimous` is reported separately, because once the vote is weighted
  "agreed" stops meaning "nobody objected" and both facts matter.

**Passing** removes your third and renormalises the agents to the whole vote.
That is what makes it different from abstaining, which parks a third on neither
side and can make agreement impossible to reach.

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
