# mcorch dashboard

The operator dashboard for [`mc-server-orchestrator`](../mc-server-orchestrator). A Next.js app
that talks to the orchestrator's `:api` module and nothing else.

It lives in its own repository on purpose: the orchestrator is a Gradle/Kotlin build with no Node
dependency, the two ship independently, and the orchestrator's `CLAUDE.md` says the SPA lives
separately.

The contract is [`api/API.md`](../mc-server-orchestrator/api/API.md) in the orchestrator repo. That
document is the specification — this app is written against it, and its §14 TypeScript block is
transcribed verbatim into `src/lib/api/types.ts`.

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
    api/types.ts                  API.md §14, transcribed
    api/client.ts                 typed calls, ETag/CSRF/If-Match handling
    api/errors.ts                 the §3 error taxonomy
    stream/sse.ts                 SSE frame parser
    stream/store.ts               the live fleet, and connection honesty
    form/definition-form.ts       form state keyed by the API's field paths
    display.ts                    how derived values are painted
  components/                     shell, panels, the drain ribbon, forms
```

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
  could live in.
