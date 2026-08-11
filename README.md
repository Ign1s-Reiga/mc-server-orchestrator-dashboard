# mcorch dashboard

The operator dashboard for
[`mc-server-orchestrator`](https://github.com/Ign1s-Reiga/mc-server-orchestrator). A Next.js app
that talks to the orchestrator's `:api` module and nothing else.

It lives in its own repository on purpose: the orchestrator is a Gradle/Kotlin build with no Node
dependency, the two ship independently, and the orchestrator's `CLAUDE.md` says the SPA lives
separately.

The contract is
[`api/API.md`](https://github.com/Ign1s-Reiga/mc-server-orchestrator/blob/main/api/API.md) in the
orchestrator repo. That document is the specification — this app is written against it, and its §14
TypeScript block is transcribed verbatim into `src/lib/api/types.ts`.

---

## Node is not on your PATH

Node was installed with `nvm`, and the install deliberately did not edit any shell rc file. **Every**
command in this README needs this first:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use --lts >/dev/null
```

Pinned versions: Node v24.18.1, npm 11.16.0.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use --lts >/dev/null
npm install
npm run dev        # http://localhost:3000
npm run build      # production build; typecheck runs as part of it
npm start          # serve the production build
npm test           # vitest, run once
npm run test:watch
```

## Pointing it at an orchestrator

| variable | default | meaning |
|---|---|---|
| `MCORCH_API_URL` | `http://127.0.0.1:8080` | where `:api` listens. **Server-side only** — the browser never sees this address and never calls it directly. |
| `DASHBOARD_ALLOWED_ORIGINS` | empty | extra origins allowed to drive this dashboard, comma-separated. Same-origin always works. |

Put them in `.env.local`.

### Running an orchestrator to develop against

`:api` needs a store and a secret store, and nothing else — it has no `:core` or `:cri` dependency.
The reconcile loop opens its CRI channel lazily and issues no RPC at startup, so the whole
orchestrator starts and serves the API with no containerd present. Servers declared against it sit
in `PENDING` with a retryable `NODE_UNAVAILABLE` failure, which is enough to develop every screen
except a live drain.

This assumes the orchestrator is checked out beside this repository.

```bash
cd ../mc-server-orchestrator
./gradlew :app:installDist

MCORCH_CRI_ENDPOINT=unix:///nonexistent/mcorch-dev.sock \
MCORCH_DATA_DIR=/tmp/mcorch-dev \
MCORCH_API_LISTEN=127.0.0.1:8080 \
MCORCH_API_TOKEN="$(head -c 32 /dev/urandom | base64)" \
  app/build/install/app/bin/app
```

The token must be at least 32 characters, and there is no default — a missing one exits 78.
Prefer `installDist` over `:app:run`: `run` is a `JavaExec` that inherits the Gradle daemon's
environment, so command-line variables are not reliably propagated to a reused daemon.

For real container states, point `MCORCH_CRI_ENDPOINT` at the project's dev containerd
(`scripts/dev/containerd-up.sh`, socket `/run/mcorch-dev/containerd.sock`) instead.

---

## How it is put together

```
src/
  app/
    layout.tsx                    fonts, providers, shell
    page.tsx                      the fleet table
    servers/new/                  create
    servers/[name]/               detail — status, conditions, drain
    servers/[name]/edit/          edit, with If-Match and 409 recovery
    secrets/                      write-only secret coordinates
    api/v1/[...path]/route.ts     reverse proxy to the orchestrator
    api/healthz/route.ts          proxied liveness, for the sign-in screen
  lib/
    api/types.ts                  API.md §14, transcribed (both kinds)
    api/client.ts                 typed calls, ETag/CSRF/If-Match handling
    api/errors.ts                 the §3 error taxonomy
    stream/sse.ts                 SSE frame parser
    stream/store.ts               the live fleet, and connection honesty
    form/definition-form.ts       form state keyed by the API's field paths
    display.ts                    how derived values are painted
    filter-chips.ts               which state chips the filter bar offers
    fleet-tree.ts                 which proxy stands in front of which server
  components/                     shell, panels, the drain ribbon, forms
    proxy-panels.tsx              backend routing and the control endpoint
    document-editor.tsx           the definition editor for non-Paper kinds
```

### Two kinds, one set of routes

`definition` and `status` are unions tagged by `kind`, returned from the same routes — there is no
`/proxies`. A `PaperServer` has `storage`; a `VelocityProxy` has `backends` and `control` and **no
storage at all**, not a null one. Everything here branches on the discriminant rather than reaching
for a field that does not exist on the union.

The proxy detail page is where a drain becomes visible across the fleet: a backend moves
`REGISTERED` → `SEALED` (no new logins) → `DEREGISTERED`, and its player count falling to zero in
between is the drain working. Two states are kept carefully apart there — `backends: null` means
nothing has looked yet, `backends` present with `matched: 0` means the selector matched nothing and
the proxy is routing players nowhere. The first resolves itself; the second needs a human.

### The fleet is a tree

A proxy and the servers behind it are one thing, so the fleet table nests them: a `VelocityProxy`
at the top level, and every `PaperServer` its backend selector claims indented beneath it. A server
no selector claims stays where it is. It is still one table — the columns ask the same questions of
every row, and two scales would make two servers incomparable — so the nesting is carried in the
name cell alone.

**The structure comes from the declared selector, not from the observed routing table.** The
orchestrator already answers "which proxy claims this backend", in `ProxyFleet.resolve`, and it
answers it from definitions; `src/lib/fleet-tree.ts` computes the same function from the same
inputs, so the shape on screen is the shape the reconcile loop acts on rather than a second, looser
idea of "related". It also means the tree is there on the first snapshot: `status.backends` is
`null` until something has looked, and a topology that only appeared after the first successful
observation would flatten itself during exactly the incident somebody opened this page for. The
observed table still has a job — each backend row carries its own `REGISTERED` / `SEALED` /
`DEREGISTERED`, read from its parent's table, which is a drain moving down the branch it belongs to
— it is just not what decides parentage. A selector that matches before the routing table has
caught up is ordinary and says nothing.

Two of `resolve`'s rules are load-bearing here, and both are pinned by tests:

- **Only a `PaperServer` is ever a backend.** `resolve` narrows to `PaperServerDefinition` before it
  matches a single label, so a proxy carrying labels that satisfy another proxy's selector is still
  not behind it. The tree is therefore exactly two levels and cannot cycle.
- **A backend belongs to one proxy.** Two claimants is not "show it twice", it is
  `Resolution.Conflicted`: the loop will not create or recreate that container until one of the
  selectors stops matching, because both proxies would route players to it and a drain would tell
  only one of them to stop. Nesting such a server under either would draw a relationship the
  orchestrator has explicitly declined to establish, so it sits at the top level behind neither,
  with a chip naming its claimants and a note saying why nothing is starting.

Filtering keeps the tree honest rather than intact. A proxy whose backends match a filter is shown
even when the proxy itself does not, dimmed and **not counted** — dropping it would let its backends
float to the top level, which says they are standalone, and that is the one thing this view exists
to get right. Collapsing a proxy is the operator's own choice and does not change the count: the
row says how many backends are folded away.

Proxies are **not** floated above standalone servers. The API sorts its list by name and so does the
store, and a top level where you cannot predict where a name lands is worse than one where the
proxies are not all together; the nesting already makes them obvious.

### One kind is edited as a document

Proxies are created and edited as a **document** rather than through the structured form. §5 sends
JSON and YAML through one parser and reports a line and column into the text as sent, so a
hand-written document gets violations pointing at the exact line typed — better than a second field
set that would be half-checked. Live `/validate`, `If-Match` and the 409 recovery are shared.

### Rows that will not decode

`status: null` has two meanings — "not observed yet" and "what was written down is corrupt" — and
only `neverObserved` tells them apart. A corrupt *observation* still returns a resource, badged
`UNREADABLE`. A corrupt *definition* has no resource at all and arrives in the list's separate
`unreadable` array, or as an `unreadable` stream event.

Those rows are never dropped and never filtered. Absence is how a purge is reported, so omitting one
would silently report a deletion that never happened on a server that may still be running. A row
with `name: null` is shown with no action at all — every repair path this API has names a server —
and while one exists the API stops emitting `removed` for *every* row, so the fleet page says
removals are paused rather than letting the table go quietly stale.

### Three decisions worth knowing about

**The browser never talks to `:api` directly.** `/api/v1/*` is reverse-proxied by a route handler.
The session cookie is `HttpOnly; SameSite=Strict` and `EventSource`-style streaming cannot set
headers, so every credentialed request — including the stream — has to be same-origin. API.md
already assumes a reverse proxy in front of the API; this is that proxy. `Origin` is stripped on the
way up (the API would otherwise 403 it), and the origin check API.md §2 performs is re-performed at
the proxy against the dashboard's own host, so the control is relocated rather than dropped.

**The event stream is read with `fetch`, not `EventSource` — and the original reason no longer
applies.** This client was first written over `fetch` because the keep-alive was an SSE *comment*
and `EventSource` cannot see comment frames, so an idle fleet could leave a dashboard rendering
half-hour-old state with `readyState === OPEN`. §8 now sends a named `ping` event that both
transports see, and presents `EventSource` as a legitimate choice again.

`fetch` is kept for a different reason: **`EventSource` cannot see the HTTP status of a failed
connection.** Its `onerror` is opaque, and this dashboard treats three failures differently — `401`
(the session is gone: stop retrying and show the sign-in), `503 STREAM_LIMIT` (retryable, honour
`Retry-After`), and a transport drop (back off and keep trying). Owning the reconnect also buys
exponential backoff with jitter rather than a fixed `reconnectMillis` with no ceiling, and an
explicit `?cursor=` resume, which §8 says wins over `Last-Event-ID`. The cookie still does the
authenticating.

Either transport needs the same watchdog, and §8 says so: `readyState === OPEN` is not evidence of
liveness, a recent `ping` is. The threshold here is `2.5 × keepAliveMillis`, read from `hello`
rather than hard-coded — below `2×` you reconnect on ordinary jitter.

**Nothing hard-codes an enumeration.** `GET /meta` serves every closed set the API can return *or
accept*, so the fleet filters and the create form are built from it (`src/components/meta-provider.tsx`).
The two spellings there are not interchangeable: observed state carries Kotlin names (`RUNNING`),
a definition carries YAML wire values (`persistent`), and a form offering `PERSISTENT` would build
a document the parser rejects.

**Filtering is client-side.** `GET /servers` takes `labelSelector`, `state` and `terminating`, but
the stream is unfiltered, so filtering the live set keeps a filter live instead of freezing it to
one list response. There is no pagination to work around — §11 says there is deliberately none.

### What the tests cover

`npm test` (vitest, node environment — the store is deliberately DOM-free) is aimed at the one
behaviour whose failure is invisible: **stream liveness**. A watchdog that silently stops firing
looks exactly like a healthy connection until an operator is reading stale numbers during an
incident.

- `src/lib/stream/store.test.ts` drives the real store through the **real SSE wire format**, so the
  parser is under test too. It covers: `ping` counting as proof of life across an idle fleet; a
  half-open socket being given up on and resumed from the last cursor; the threshold coming from
  the served `keepAliveMillis` rather than a constant; a proxy-injected comment counting as traffic
  but not as an event; a stream that opens `200` and closes immediately being backed off rather
  than redialled in a spin; a `bye` after a full lifetime reconnecting at once *without* counting
  an attempt; a `401` reaching the session-lost listeners; and `Retry-After` being honoured on
  `503 STREAM_LIMIT`.
- `src/lib/fleet-tree.test.ts` pins the tree against `ProxyFleet.resolve`, because the two computing
  different answers is invisible until an operator drains the wrong branch: a proxy is never nested
  under another proxy however its labels read; a selector is an AND of equalities; a server two
  selectors claim is `conflicted` and sits under neither; and a filter that hides a proxy keeps it
  as an uncounted context row rather than orphaning its backends to the top level.
- `src/lib/form/definition-form.test.ts` pins two contract invariants: that a fetched `Definition`
  is assignable to `DefinitionInput` with no cast (§14's round-trip claim — the assignment *is* the
  test), and that unset optional fields are omitted rather than sent as `null` (§6 — an explicit
  `null` is a violation, not "use the default").

These complement rather than replace exercising the app against a live orchestrator, which is what
found the reconnect-spin bug and the 401-propagation gap in the first place.

### What this dashboard will not do

- **No stop, kill, force or restart control.** There is no such endpoint and there will not be one:
  an endpoint that could stop a container could stop one with players on it. Deleting is the drain
  trigger, editing the spec is the replace trigger.
- **A `202` from `DELETE` does not remove the row.** The server keeps its row, showing
  `TERMINATING` and the drain's progress, until the stream sends `removed` or `GET` answers `404`.
- **Nothing is shown optimistically.** Every state on screen is one the API reported. A mutation's
  own response body is folded into the live set, because that is observed state the API returned —
  but nothing is ever rendered as having happened before the API said it did.
- **No secret can be read back.** `GET` on a secret value is `405`, always. There is no reveal, no
  export, no preview.
- **No player identity, anywhere.** The API exposes counts only, and there is no field an identity
  could live in. That includes the proxy's per-backend view, which sees every player in the fleet
  and reports none of them.
- **A waiting drain is not a failed one.** `DRAIN_FAILED` means *parked*, not *broken*;
  `drain.blocked` and `drain.failure` are disjoint and tell them apart. A blocked drain records no
  failure at all, so a server with people happily playing on it does not light up every
  "is anything wrong" panel.

---

## License

[MIT](LICENSE).
