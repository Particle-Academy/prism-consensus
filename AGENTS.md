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
