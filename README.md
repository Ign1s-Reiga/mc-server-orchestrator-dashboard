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

**The event stream is read with `fetch`, not `EventSource`.** API.md §8 suggests `EventSource`, and
its reasoning is good. The problem is that `EventSource` does not expose comment frames, and the
API's `: keep-alive` every 15s is the only traffic on an idle fleet until the 30-minute
`maxLifetimeMillis` cycle. Through `EventSource` a half-open socket — a slept laptop, a NAT timeout,
a proxy that vanished — would leave the dashboard showing half-hour-old state while claiming to be
live. Reading the stream directly makes keep-alives visible, so silence beyond two keep-alive
periods is a reliable signal, and reconnects use `?cursor=`, which §8 says wins over
`Last-Event-ID`. The cookie still does the authenticating.

**Filtering is client-side.** `GET /servers` takes `labelSelector`, `state` and `terminating`, but
the stream is unfiltered, so filtering the live set keeps a filter live instead of freezing it to
one list response. There is no pagination to work around — §11 says there is deliberately none.

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
