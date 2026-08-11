# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Node is not on your PATH

Node was installed with `nvm` and the install deliberately edited no shell rc file. **Every** command
below needs this prefix, in the same shell invocation:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use --lts >/dev/null
```

Pinned: Node v24.18.1, npm 11.16.0.

## Commands

```bash
npm run dev          # http://localhost:3000
npm run build        # production build — runs the TypeScript check as part of it
npm start            # serve the production build
npm test             # vitest, run once
npm run test:watch
npx tsc --noEmit     # typecheck alone, faster than a build
```

There is **no lint script and no ESLint config**. `npm run build` (or `npx tsc --noEmit`) is the
static check.

Single test file, or a single case by name:

```bash
npx vitest run src/lib/fleet-tree.test.ts
npx vitest run -t 'never puts a proxy behind another proxy'
```

### Running an orchestrator to develop against

`:api` needs only a store and a secret store — no `:core`, no `:cri` — and its reconcile loop opens
its CRI channel lazily, so the whole thing serves the API with no containerd present. Servers sit in
`PENDING` with a retryable `NODE_UNAVAILABLE`, which exercises every screen except a live drain.

```bash
cd ../mc-server-orchestrator && ./gradlew :app:installDist

MCORCH_CRI_ENDPOINT=unix:///nonexistent/mcorch-dev.sock \
MCORCH_DATA_DIR=/tmp/mcorch-dev \
MCORCH_API_LISTEN=127.0.0.1:8080 \
MCORCH_API_TOKEN="$(head -c 32 /dev/urandom | base64)" \
  app/build/install/app/bin/app
```

The token must be ≥32 characters; a missing one exits 78. Prefer `installDist` over `:app:run` — the
latter is a `JavaExec` that inherits the Gradle daemon's environment, so command-line variables are
not reliably propagated to a reused daemon.

Environment (`.env.local`): `MCORCH_API_URL` (default `http://127.0.0.1:8080`, **server-side only**)
and `DASHBOARD_ALLOWED_ORIGINS` (comma-separated extras; same-origin always works).

## The contract lives in another repository

This app talks to the `:api` module of
[`mc-server-orchestrator`](https://github.com/Ign1s-Reiga/mc-server-orchestrator) and nothing else.
**`api/API.md` in that repo is the specification.** The orchestrator is normally checked out beside
this one at `../mc-server-orchestrator` — read it. The `§N` references that appear throughout this
codebase's comments are sections of `API.md`, and questions about behaviour ("does the selector
match proxies too?", "what does the loop do with two claimants?") are answerable by reading the
Kotlin in `:core` and `:schema`.

`src/lib/api/types.ts` is API.md §14 **transcribed**, and is meant to diff cleanly against it. Do
not add convenience or derived fields there — derive them in `src/lib/display.ts`, in a `src/lib/*`
module, or in the component. Where this file knowingly departs from §14 it says so and names the
section that overrides it (see `ConditionType`).

## Architecture

### The browser never talks to `:api` directly

`/api/v1/*` is reverse-proxied by `src/app/api/v1/[...path]/route.ts` → `src/lib/upstream.ts`. This
is not a convenience: the session cookie is `HttpOnly; SameSite=Strict` and an `EventSource`-style
stream cannot set headers, so every credentialed request — the stream included — has to be
same-origin. The handler adds no behaviour beyond an origin check; statuses, `ETag`, `Location`,
`Retry-After`, the error envelope and the SSE body all pass through untouched.

`Origin` is **stripped** on the way up (the API compares it against its own `Host` and would 403
everything), and the §2 origin check is re-performed at the proxy against the dashboard's host — the
control is relocated, not dropped. `MCORCH_API_URL` is read in a `server-only` module and never
reaches the browser.

### Provider stack

`src/app/layout.tsx`: `SessionProvider` → `MetaProvider` → `FleetProvider` → `Shell`. Each depends
on the one above it — `MetaProvider` fetches only once authenticated, `FleetProvider` streams only
once authenticated.

### The live fleet is one store, and it is honest about being live

`src/lib/stream/store.ts` owns the SSE connection and is the single source of the fleet for every
page (`useFleet`, `useServer`). It is deliberately **DOM-free** — visibility handling lives in
`fleet-provider.tsx` — which is why its tests run in vitest's node environment.

The stream is read with `fetch`, not `EventSource`, and the reason is specific: `EventSource`'s
`onerror` is opaque, and three failures are treated differently here — `401` (session gone: stop,
show sign-in), `503 STREAM_LIMIT` (retryable, honour `Retry-After`), and a transport drop (back off
and retry). Owning the reconnect also buys jittered exponential backoff and an explicit `?cursor=`
resume, which §8 says wins over `Last-Event-ID`.

`readyState === OPEN` is not evidence of liveness; a recent `ping` is. The watchdog threshold is
`2.5 × keepAliveMillis` **read from the `hello` frame**, not hard-coded — below `2×` you reconnect
on ordinary jitter.

A `401` from any request broadcasts through `notifySessionLost()` in `src/lib/api/client.ts`; the
stream is usually the first to notice, because it is the only always-open connection.

### Two kinds, one set of routes

`Definition` and `ServerStatus` are unions tagged by `kind`, returned from the same routes — there
is no `/proxies`. A `PaperServer` has `storage`; a `VelocityProxy` has `backends` and `control` and
**no storage at all**, not a null one. Always branch on the discriminant; never reach for a field
that does not exist on the union. `src/lib/api/kinds.test.ts` exists to catch exactly that.

Proxies are created and edited as a **document** (`document-editor.tsx`) rather than through the
structured form, because §5 sends JSON and YAML through one parser and reports a line and column
into the text *as sent* — so a hand-written document gets violations pointing at the exact line
typed.

### Fleet topology (`src/lib/fleet-tree.ts`)

The fleet table nests backends under the proxy that claims them. Parentage is computed from the
**declared selector**, mirroring `ProxyFleet.resolve` in the orchestrator's `:core` — not from the
observed `status.backends` table, which is `null` until something has looked. Three rules come from
`resolve` and must not be relaxed: only a `PaperServer` is ever a backend (so the tree is two levels
and cannot cycle); a selector is an AND of equalities; and a server two selectors claim is
`conflicted` and belongs to neither, because the loop refuses to create its container at all. If
`resolve` changes upstream, this file and its test change with it.

## Invariants that are easy to break

- **Nothing hard-codes an enumeration.** `GET /meta` (§10) serves every closed set, so filters and
  forms are built from it (`meta-provider.tsx`). The `FALLBACK_*` constants cover only the moment
  before `/meta` lands. The two spellings there are **not** interchangeable: observed state carries
  Kotlin names (`RUNNING`), a definition carries YAML wire values (`persistent`), and a form
  offering `PERSISTENT` builds a document the parser rejects.
- **`display.*` is derived by the API (§7). Never recompute it.** `display.ts` says how each value
  is *painted* and what it means; it does not re-derive state. In particular `display.proxy`'s
  counts are served precisely so tables do not re-derive them per row (`registered` counts
  `REGISTERED` *and* `SEALED`, which is not what a client would guess).
- **Nothing is shown optimistically.** Every state on screen is one the API reported. A mutation's
  own response body may be folded into the live set — that is observed state the API returned — but
  nothing renders as having happened before the API said it did. A `202` from `DELETE` does not
  remove the row.
- **Unreadable rows are never dropped and never filtered.** Absence is how a purge is reported, so
  omitting one would silently report a deletion that never happened on a server that may still be
  running. `status: null` has two meanings and only `neverObserved` tells them apart. A row with
  `name: null` gets no action at all, and while one exists the API stops emitting `removed` for
  *every* row — hence `removalsSuspended`.
- **Never branch on an error `message`.** §3 says so; `errors.ts` exposes `code` for that.
- **`drainBlocked` and `needsAttention` are ordered, not exclusive** (§7 retracts an earlier claim
  that they were). `DRAIN_FAILED` means *parked*, not *broken*; `drain.blocked` and `drain.failure`
  are disjoint.
- **Optional fields are omitted, never `null`.** An explicit `null` in a definition is a §6
  violation, not "use the default". `JSON.stringify` dropping `undefined` is what makes this work.
- **No stop/kill/restart control, no secret read-back, no player identity.** There is no endpoint
  for any of them, and there will not be. Do not add UI that implies otherwise.
- **Filtering is client-side.** `GET /servers` accepts filters but the stream is unfiltered, so
  filtering the live set keeps a filter live rather than freezing it to one list response. There is
  no pagination — §11 says there deliberately is none.

## Conventions

- **Comments explain *why*, and cite the contract.** The prevailing style is a block comment naming
  the failure a piece of code prevents, with a `§N` reference. Match that density; this codebase is
  unusually heavily commented on purpose.
- **Typography is semantic** (see the header of `globals.css`): mono for anything that came out of
  the data model — names, states, resource versions, durations, field paths, counts — and sans for
  language written to be read. Colour is spent, not spread: saturation is reserved for `READY`, a
  drain in flight (gold, because it is correct behaviour, not an error), and failure /
  `NEEDS_ATTENTION`. Tones go through `Tone` / `TONE_COLOR` in `display.ts`, never raw hex.
- **Form state is keyed by the API's dotted field paths** (`FIELD_PATHS` in
  `lib/form/definition-form.ts`), so attaching a violation to its input is a lookup rather than a
  mapping table that drifts.
- **Tests target behaviour whose failure is invisible**, not coverage: stream liveness, the
  `Definition` → `DefinitionInput` round-trip, kind discrimination, the tree matching `resolve`.
  They complement exercising the app against a live orchestrator, which is what found the
  reconnect-spin bug and the 401-propagation gap.

## Git

Conventional Commits, imperative mood, lowercase, no trailing period, one commit per logical change.
Branches are `<type>/<hyphenated-abstract>`. Commit bodies in this repository are long and explain
the reasoning — match the existing log.
