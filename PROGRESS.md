# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update it at the end of every work session. Never leave it stale.

Last updated: 2026-11-08 (session 7 — Phase 6 complete)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 6 — backups, alerts, production: DONE**. All six phases built. |
| Verified state | 229 backend tests pass, `tsc` clean both packages, `npm audit` 0 vulns, real deploy of `Sidharth7082/capturehost-test-app` live on 127.0.0.1:8101, screenshots at 1440 and 390 |
| Last commit | `feat(phase-4): github deployments, webhooks and rollback` |
| Next action | none — the build is complete; production runner is option A (systemd, `deploy/systemd/`) |

---

## 2. Phase checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done + verified by running it

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, git, tracking docs | `[x]` |
| 1 | Monitoring: `/api/health`, `ws /ws/metrics`, SQLite 24 h history, dashboard | `[x]` |
| 2 | Auth: argon2, sessions, CSRF, rate limit, TOTP, audit log | `[x]` |
| 3 | Docker: socket proxy, container control, live logs | `[x]` |
| 4 | GitHub deploy: clone, build, webhook HMAC, rollback | `[x]` |
| 5 | Domains + Caddy admin API + HTTPS | `[x]` |
| 6 | Backups, notifications, retention, doctor, production setup | `[x]` |

---

## 3. Machine / environment facts (verified 2026-11-08)

| Fact | Value |
|---|---|
| OS | Arch Linux, kernel 7.2.11-arch1-1 |
| CPU | 12 threads |
| RAM | 31 GiB total |
| Disk | `/` on nvme0n1p3, 433G total, ~97G free |
| Node | v26.13.0 (`/usr/bin/node`) — `.env` loaded via `process.loadEnvFile` |
| npm | 12.2.1 |
| Docker | daemon 29.9.2, compose v5.6.1 (`pacman -S docker-compose`), client `~/.local/bin/docker` |
| Socket proxy | `capturehost-socket-proxy` running, `127.0.0.1:2375`, socket mounted **ro** |
| GPU | RTX 3050 Laptop, 4096 MiB — `nvidia-smi` works |
| Caddy | **NOT installed** — `pacman -S caddy` in Phase 5 |
| SQLite CLI | `/usr/bin/sqlite3` |
| Repo | `/home/capture/capturehost` |
| git identity | Sidharth7082 / sidharthkaushal558@gmail.com |
| Local dev admin | username `sid`, **2FA off** |
| Pre-existing containers | `beautiful_heisenberg` (hello-world, exited) — **never touch** |

---

## 4. Running it (dev)

```bash
# first time only
cd ~/capturehost/backend && cp .env.example .env
openssl rand -base64 32        # paste into APP_ENCRYPTION_KEY
npm run setup:admin            # interactive; creates the only admin account

# socket proxy (needed from Phase 3 on)
cd ~/capturehost && docker compose -f docker-compose.dev.yml up -d

# every time
cd ~/capturehost/backend  && npm run dev     # :8787, loopback only
cd ~/capturehost/frontend && npm run dev     # :5173, proxies /api + /ws

# live docker check (touches only its own labelled container)
DOCKER_API_PASSWORD='…' node scripts/integration-docker.mjs
```

---

## 5. What each phase shipped

### Phase 1 — monitoring
- `config.ts`, `server.ts` (`createServer` + `AppInstance`), `app.ts` (`buildApp`),
  `index.ts` (listen on 127.0.0.1 only)
- `db/connection.ts` (WAL), `db/migrate.ts` + `001_core.sql` (all 8 tables)
- `db/metrics.repo.ts`, `services/gpu.ts`, `services/metrics.ts` (one global sampler)
- `routes/health.ts`, `routes/metrics.ts` (history + WS hub), `middleware/errorHandler.ts`
- Frontend design system: tokens/base/layout CSS, 17 components, 8 pages, SVG charts

### Phase 2 — authentication
- `config.ts` additions — `APP_ENCRYPTION_KEY`, session idle/absolute, `__Host-`
  cookie naming, argon2 cost, lockout window, `TRUST_PROXY`
- `crypto/password.ts` (argon2id + dummy verify), `crypto/token.ts`,
  `crypto/secretbox.ts` (AES-256-GCM), `crypto/totp.ts` (otplib v13)
- `db/migrations/002_auth.sql` — ALTER only; `db/auth.repo.ts`, `db/audit.repo.ts`
- `services/auth.ts`, `services/socketRegistry.ts`, `middleware/auth.ts` (global guard)
- `routes/auth.ts`, `routes/audit.ts`, `scripts/{setup,reset}-admin.ts`, `utils/env.ts`
- Frontend: `auth/AuthContext.tsx`, `auth/RequireAuth.tsx`, `pages/Login.tsx`,
  `pages/Settings.tsx` + `settings/*Section.tsx`, real `pages/Logs.tsx`

### Phase 3 — Docker
- `docker-compose.dev.yml` — `tecnativa/docker-socket-proxy:0.2.0`, socket mounted
  read-only into the **proxy only**, published on `127.0.0.1:2375`, labelled
  `capturehost.protected=true`; only CONTAINERS/IMAGES/INFO/EVENTS/PING/POST on
- `config.ts` — `DOCKER_HOST_URL`, `DOCKER_TIMEOUT_MS` (30 s), `DOCKER_STATS_INTERVAL_MS`,
  `DOCKER_PROTECTED_CONTAINERS`, `DOCKER_ACTIONS_PER_MINUTE`; startup warning if the
  URL looks like a socket path
- `services/docker.ts` — dockerode client, list/inspect/action/remove, filtered
  inspect (env **key names only**), `followLogs` with ANSI stripping + line cap,
  protected-container rules, `toAppError` (404/409/503 mapping), `mapStats` CPU math,
  `parseDockerUptime`
- `services/dockerStats.ts` — one shared poller, stops when the last subscriber leaves
- `routes/docker.ts` — status, list, inspect, start/stop/restart, remove, WS logs,
  WS stats; session rate limit; audit on every action and denial
- `middleware/auth.ts` — `authenticateUpgrade()` shared by all sockets
- `utils/rateLimit.ts` — `SessionRateLimiter` (in-memory, 30 actions/min/session)
- `scripts/integration-docker.mjs` — live end-to-end check (not in CI)
- Frontend: `pages/Containers.tsx`, `pages/containers/{LogsDrawer,InspectDrawer}.tsx`,
  `components/Drawer.tsx`, `hooks/{useContainers,useDockerStats,useContainerLogs}.ts`

### Phase 4 — GitHub deployment
- `docker-compose.dev.yml` — `BUILD: 1` added (BUILD was 0); SESSION/GRPC stay 0 so
  only classic `POST /build` is reachable. New `capturehost-apps` bridge network is
  created by compose through a one-shot `network-init` container (the proxy is
  deliberately **not** on it). Comment explains that the proxy filters by URL, not
  by body, so the backend enforces container safety itself.
- `db/migrations/003_deployments.sql` — project runtime columns (slug, ports, health
  path, limits, container id, encrypted webhook secret + GitHub token), deployment
  bookkeeping, `webhook_deliveries` (primary key = `X-GitHub-Delivery`).
- `004_deployment_states.sql` — rebuilds `deployments` with the real state list
  (`queued→cloning→building→starting→health-check→live`, plus failed/cancelled/rolled-back).
- `005_project_capabilities.sql` — per-project `capabilities` CSV (allowlist enforced in code).
- `services/containerPolicy.ts` — **the only place a container config is produced**:
  explicit whitelist, `CapDrop: ALL` + 4-capability allowlist, `no-new-privileges`,
  no binds/devices, loopback-only published port inside a range, memory/swap/cpu/pids,
  `unless-stopped`, labels `capturehost.managed/project/deployment`. `assertSafeContainerOptions()`
  re-validates the finished payload (privileged, binds, host net/pid/ipc, devices,
  caps, missing limits, 0.0.0.0 publish, restart policy).
- `services/git.ts` — strict `https://github.com/owner/repo` zod pattern, `execFile`
  argv with `--` before the URL, `GIT_TERMINAL_PROMPT=0`, `credential.helper=`,
  shallow single-branch no-tags clone into a fresh dir, timeout, size cap,
  symlink-escape check, token via a 0700 askpass script (never in URL/argv/logs).
- `services/deployments.ts` — one-build-at-a-time queue, state machine, log capture
  with consecutive-line collapse, blue/green swap on a **fresh host port per deploy**,
  health check (restart-loop aware, two stable samples when no HTTP path), image
  retention (`capturehost/<slug>:<sha>`, keep N), rollback without rebuild, cancel.
- `services/logHub.ts` — fan-out for live build logs.
- `db/projects.repo.ts` — all project/deployment/env queries + delivery dedupe.
- `routes/projects.ts` — CRUD, deploy, cancel, rollback, env (write-only values),
  webhook secrets, `WS /ws/deployments/:depId/logs`, `/api/project-ports`.
- `routes/webhook.ts` — HMAC-SHA256 over the **raw** body (`timingSafeEqual`),
  verified before parsing; push/branch filter, ping, replay-safe, per-IP limit, audit.
- `app.ts` — raw-body content-type parser for the webhook path only, `DeploymentService`
  wiring, `PUBLIC_PREFIXES` for `/api/webhooks/github/`.
- `scripts/integration-deploy.mjs` — create → deploy → fetch → redeploy → rollback →
  env round trip → delete, scoped to its own project.
- Frontend: `api/projects.ts`, rewritten `pages/Projects.tsx`, `pages/ProjectDetail.tsx`
  (Overview/Deployments/Logs/Environment/Settings), `pages/projects/{NewProjectModal,DeploymentLog}.tsx`,
  `styles/projects.css`, tab strip scrolls at 390px.

---

## 6. Route inventory (actual — auth + CSRF)

| Method | Path | Auth | CSRF |
|---|---|---|---|
| GET | `/api/health` | **public** | n/a |
| GET | `/api/auth/setup-status` | **public** | n/a |
| POST | `/api/auth/login` | public (Origin checked) | n/a |
| POST | `/api/auth/login/2fa` | pending-2FA session | n/a |
| POST | `/api/auth/logout` | session | **yes** |
| GET | `/api/auth/me` | session | n/a |
| POST | `/api/auth/change-password` | session | **yes** |
| GET | `/api/auth/sessions` | session | n/a |
| DELETE | `/api/auth/sessions/:id` | session | **yes** |
| POST | `/api/auth/sessions/revoke-others` | session | **yes** |
| POST | `/api/auth/2fa/setup` | session | **yes** |
| POST | `/api/auth/2fa/confirm` | session | **yes** |
| POST | `/api/auth/2fa/disable` | session | **yes** |
| GET | `/api/audit` | session | n/a |
| GET | `/api/metrics/history` | session | n/a |
| WS | `/ws/metrics` | session **+** Origin allowlist | n/a |
| GET | `/api/docker/status` | session | n/a |
| GET | `/api/docker/containers` | session | n/a |
| GET | `/api/docker/containers/:id` | session | n/a |
| POST | `/api/docker/containers/:id/start` | session | **yes** (+rate limit) |
| POST | `/api/docker/containers/:id/stop` | session | **yes** (+rate limit) |
| POST | `/api/docker/containers/:id/restart` | session | **yes** (+rate limit) |
| DELETE | `/api/docker/containers/:id` | session | **yes** (+rate limit) |
| WS | `/ws/docker/logs/:id` | session **+** Origin allowlist | n/a |
| WS | `/ws/docker/stats` | session **+** Origin allowlist | n/a |
| GET | `/api/projects` | session | n/a |
| POST | `/api/projects` | session | **yes** |
| GET | `/api/projects/:id` | session | n/a |
| PATCH | `/api/projects/:id` | session | **yes** |
| DELETE | `/api/projects/:id?confirm=<name>` | session | **yes** |
| POST | `/api/projects/:id/deploy` | session | **yes** (+rate limit) |
| GET | `/api/projects/:id/deployments` | session | n/a |
| POST | `/api/projects/:id/deployments/:depId/cancel` | session | **yes** |
| POST | `/api/projects/:id/rollback` | session | **yes** (+rate limit) |
| GET | `/api/projects/:id/env` | session | n/a |
| PUT | `/api/projects/:id/env` | session | **yes** |
| DELETE | `/api/projects/:id/env/:key` | session | **yes** |
| GET | `/api/projects/:id/webhook` | session | n/a |
| GET | `/api/project-ports` | session | n/a |
| WS | `/ws/deployments/:depId/logs` | session **+** Origin allowlist | n/a |
| POST | `/api/webhooks/github/:projectId` | **public** — HMAC over the raw body | n/a |

| GET | `/api/domains` | session | n/a |
| POST | `/api/domains` | session | **yes** |
| PATCH | `/api/domains/:id` | session | **yes** |
| DELETE | `/api/domains/:id` | session | **yes** |
| POST | `/api/domains/:id/check` | session | **yes** |
| GET | `/api/projects/:id/domains` | session | n/a |
| GET | `/api/caddy/status` | session | n/a |

| GET | `/api/backups` | session | n/a |
| POST | `/api/backups` | session | **yes** |
| DELETE | `/api/backups/:id` | session | **yes** |
| POST | `/api/backups/:id/download` | session **+ password re-entry** (+3/min) | **yes** |
| GET | `/api/notifications` | session | n/a |
| POST | `/api/notifications/read` | session | **yes** |
| GET | `/api/notifications/channel` | session | n/a |
| POST | `/api/notifications/test` | session | **yes** |
| GET | `/api/doctor` | session | n/a |

No reserved routes left.
There is deliberately **no exec endpoint and no create-container endpoint**; the only
way a container is created is the deploy pipeline, which owns the safety policy.

---

## 7. Decisions locked

### Phase 1
1. `createServer()` in `server.ts` returns an instance typed with our pino
   `Logger`; `AppInstance` is that type.
2. Baseline schema (all 8 tables) lives in `001_core.sql`; later phases only add
   `002_*`, `003_*`.
3. WS Origin allowlist: **a missing Origin is rejected too**.
4. One global sampler fans out to all sockets; the frontend holds one socket.
5. History bucketing in SQL; inner query takes newest buckets, outer re-sorts.
6. GPU absent ⇒ `null`, never `0`.
7. Plain CSS + custom properties, hand-rolled SVG charts, Inter bundled locally.
8. Dev proxy in `vite.config.ts` ⇒ one origin, no CORS needed.
9. `trustProxy` off until a real proxy exists.

### Phase 2
10. **Two 401 codes.** `unauthenticated` = no valid session (client logs out);
    any other 401 means the action failed, so a typo never ejects the user.
11. **Pending-2FA sessions are not sessions** — 5 min, rotated on success.
12. **Token rotation twice**: pending state, then after the 2FA step.
13. **Rate-limit state in SQLite**: a restart must not clear a lockout.
14. **Identical work for unknown users** (`runDummyVerify`).
15. **CSRF is session-bound**, `x-csrf-token`, `timingSafeEqual`.
16. **TOTP ±1 window tolerance, replay blocked by `afterTimeStep`.**
17. **Recovery codes**: 8, once, SHA-256, consumed atomically.
18. Guard order: Origin → session → public test → pending-2FA → CSRF.

### Phase 3
19. **The app never holds the Docker socket.** Only the proxy container mounts it,
    read-only. `DOCKER_HOST_URL` is HTTP; a socket path logs a loud warning.
20. **Protected containers** are enforced server-side (label
    `capturehost.protected=true`, the proxy name, or any name/id in
    `DOCKER_PROTECTED_CONTAINERS`) — the UI disabling a button is cosmetic.
21. **`STOP_GRACE_SECONDS = 5` must stay well under `DOCKER_TIMEOUT_MS`.** Docker
    only answers once the container is down; a 10 s grace against a 5 s client
    timeout looked exactly like "proxy unreachable" (`socket hang up`).
22. **One stats poller**, stopped when the last subscriber leaves; the REST list
    stays the source of truth for what exists.
23. **Env values never leave the server** — inspect returns key names only.
24. **Logs**: `tail` default 200 / max 2000, ANSI stripped, lines capped at 2000
    chars, frames dropped above 1 MB of buffered data (with a `dropped` notice).
25. **Action rate limit in memory, not SQLite** — it guards against a stuck loop
    or double-click storm, not an attacker who owns the session.
26. **Uptime comes from Docker's status string** (`parseDockerUptime`), because
    `listContainers` has no `StartedAt`; unrecognised strings show "—".

### Phase 4
27. **Safety lives in the backend, not the proxy.** The socket proxy filters URLs
    and methods, never request bodies, so `services/containerPolicy.ts` is the only
    producer of container config and re-validates its own output before sending it.
28. **Capabilities: `CapDrop: ALL` + a 4-entry allowlist** (`NET_BIND_SERVICE`,
    `CHOWN`, `SETUID`, `SETGID`). Stock `nginx:alpine` needs all four — without them
    it dies with `chown("/var/cache/nginx/client_temp") failed`. Anything else
    (`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`) is refused before a payload exists.
29. **Every deploy gets a fresh host port.** Blue/green cannot publish the port the
    old container still holds ("port is already allocated"); the project's port
    column is updated after the swap, and the pipeline retries the next free port if
    Docker still disagrees. Phase 5 will front this port with Caddy.
30. **Health check must be restart-loop aware.** A crash-looping container is briefly
    "running", so `State.Restarting` counts as failure, and with no HTTP path the
    process must stay up across two samples ~1s apart.
31. **Git tokens never touch argv or the URL** — a 0700 askpass script in a temp
    dir, deleted in `finally`. `credential.helper=` is cleared so a cached
    credential cannot silently change who we authenticate as.
32. **The webhook holds the raw body.** A dedicated content parser keeps the buffer
    only for `/api/webhooks/github/`; HMAC is verified before JSON is parsed,
    `timingSafeEqual` compares, and `X-GitHub-Delivery` is the primary key of
    `webhook_deliveries` so a replay inserts nothing.
33. **Deployments state list is `queued→cloning→building→starting→health-check→live`**
    plus failed/cancelled/rolled-back (migration 004 rebuilds the table; the 001 list
    did not describe the pipeline). `projects.status` keeps the 001 vocabulary
    (`idle`/`deploying`/`running`/`failed`).
34. **One build at a time.** A laptop building two images at once makes both look
    broken; the queue is in memory and a restart drops it (the deployment row stays
    `queued` and can be cancelled).

---

### Phase 5
35. **The Caddy admin API has no auth**, so the client refuses any non-loopback
    `CADDY_ADMIN_URL` at construction and the Caddyfile binds `127.0.0.1:2019`.
36. **Routes are appended, never written wholesale.** The admin API rejects PUT
    on a route array ("key already exists") and only accepts an array when the
    list does not exist yet; the client tracks that and uses DELETE-by-@id plus
    POST (array on creation, single route afterwards).
37. **The 404 catch-all belongs to the backend**, tagged `capturehost-catchall`
    and re-appended last on every sync. A catch-all in the Caddyfile would sit
    first and shadow every deployed site, and a server with no routes answers
    200 instead of 404.
38. **Upstream allowlist is by port**, not by project: 2375/2019/8787/8090/5173
    and anything outside the app range are refused before a route is built.
39. **Blue/green includes the hostname**: the route moves to the new port while
    the old container still serves, the hostname is probed through Caddy, and a
    failure reverts the upstream and fails the deployment.
40. **Desired state lives in SQLite** and is re-applied on boot and every
    `CADDY_SYNC_INTERVAL_MS`; drift is counted and audited (`caddy.drift_repaired`).
41. **`trustProxy` is a predicate, not `true`**: X-Forwarded-For is believed
    only when the immediate peer is `TRUST_PROXY_ADDRESSES` (loopback), so a
    spoofed header from anywhere else cannot move the login-lockout key.

### Phase 6
42. **Backups use SQLite's online snapshot**, not a file copy, then gzip +
    AES-256-GCM with `BACKUP_ENCRYPTION_KEY` (separate from `APP_ENCRYPTION_KEY`,
    so one leak does not open both). Every backup runs `integrity_check` before
    it is written and again when verified.
43. **Restore refuses while the backend is listening** and keeps
    `<db>.before-restore-<ts>` next to the database before overwriting it.
44. **Notifications dedupe by key + cooldown** (default 30 min), so a restart
    loop produces one alert per window. The outbound channel is https-only, DNS
    is resolved and private/loopback/link-local answers are refused, redirects
    are not followed, and the URL path (where ntfy/Discord put the secret) is
    never returned to the UI.
45. **Retention deletes only rows older than the window**, and only from tables
    this app owns. Docker image retention stays in the deploy pipeline (keep N
    per project) and project deletion — there is no global prune anywhere.
46. **The doctor is read-only**: it inspects config, the proxy's answers, file
    modes and git, and prints no secret values, only whether something is set.
47. **Production runner is option A** (systemd + dedicated `capturehost` user,
    outside the docker group, `deploy/systemd/capturehost.service`), because it
    keeps Caddy's admin API on loopback and needs no image rebuilds; option B
    (compose) is written up in `deploy/DESIGN-NOTE.md` but not shipped.

## 8. Known gaps / deliberate deferrals

- **Phase 5 prerequisites (flagged by the user, do not forget):**
  - When Caddy sits in front, set `TRUST_PROXY=true`, otherwise every request
    arrives as `127.0.0.1` and the per-IP login lockout becomes one shared
    bucket — one wrong password locks the world out.
  - Set `SESSION_COOKIE_SECURE=true` the moment the dashboard is served over
    HTTPS (the cookie then also gains the `__Host-` prefix).
- `docker-compose.yml` for production — Phase 6 (dev compose exists).
- **The deployment queue is in memory** — a backend restart loses queued builds
  (the row stays `queued`; cancel it and deploy again).
- **Webhooks need a tunnel.** The backend listens on 127.0.0.1, so GitHub cannot
  reach `/api/webhooks/github/:id` directly. Expose only that path (Cloudflare
  Tunnel / Tailscale Funnel) before turning the webhook on in the repo settings.
- **Only deploy repositories you trust.** Builds run arbitrary code from the
  Dockerfile (and the container runs it). There is no sandbox beyond the container
  policy yet.
- Failed image builds leave layer cache behind; `docker builder prune` occasionally.
- No per-project build args, no compose/multi-service projects, no Dockerfile
  generation — deliberate (Dockerfile required).
- Disk stat card has no sparkline.
- No "forgot password" by design: recovery is `npm run reset:admin` from a shell.
- Events that emit into the feed today: deploy failed, scheduled backup failed,
  disk above threshold, Caddy unreachable, Caddy drift. Not yet wired: container
  restart loop / unexpected exit, domain check failing repeatedly, login lockout,
  repeated webhook rejections (the feed accepts them; nothing raises them yet).
- `npm run doctor` and the Security page are read-only by design.
- Light theme toggle and the disk sparkline were deliberately skipped (Phase 6
  says skip anything needing a new phase; both need design work on the token set).
- `public` mode is implemented but **untested** (needs a real domain and an
  inbound port); the README says so.
- The Caddyfile's dashboard site answers an empty 200 (not 404) for a foreign
  Host on `:8090`; it never serves the dashboard for it, but the status code is
  cosmetic.
- No certificate probes yet in local mode (`https_ok` stays null until public
  mode is used).
- Webhook gateway (`WEBHOOK_PUBLIC_HOST`) is documented but not enabled.
- Audit log has no retention/rotation yet (Phase 6).
- No container **create** or **exec** from the UI — deliberate (containers are only
  created by the deploy pipeline, which owns the safety policy).
- Inspect shows env **names only**; editing env vars happens per project (Phase 4).
- The stats poller calls `listContainers` every tick; fine for a laptop, would
  want the event stream on a busier host.

---

## 9. Session log (append-only, newest last)

### 2026-11-08 — session 1
- Verified machine facts; created repo skeleton, `.gitignore`, this file, git init.

### 2026-11-08 — session 2
- Phase 1 built end to end (30 tests): config, db + migrations, sampler, GPU
  probe, health + history + WS routes, error handler; frontend design system and
  live dashboard.
- Two bugs caught by looking at the render: `<button>` text-align centring nav
  labels, and sparklines auto-scaling instead of a 0–100 domain.

### 2026-11-08 — session 3
- Phase 2 shipped (77 tests): argon2id + dummy verify, sessions with rotation,
  CSRF, Origin checks, SQLite lockout, TOTP with replay guard + recovery codes,
  audit log + paginated API, socket registry closing sockets on logout.
- Bugs found by using the app: a failed 2FA code logged the session out; TOTP had
  zero tolerance; nothing loaded `.env`; recovery codes rendered over the disable
  form.

### 2026-11-08 — session 4
- Phase 3 shipped (121 tests): socket proxy, dockerode over TCP, list/inspect/
  control/remove, live log + stats sockets, protected containers, action rate
  limit, audit on every action and denial, Containers page with drawers.
- Verified: proxy blocks `/secrets`, `/volumes`, `/networks` (403) while
  start/stop/remove work; `scripts/integration-docker.mjs` green against the real
  daemon; backend process has no `docker.sock` fd; socket mounted ro in the proxy
  only; port published on 127.0.0.1.
- Bugs found by using the app, not by tests:
  - **stop returned 503 "Docker unavailable"** because Docker answers only after
    the container dies (10 s grace vs 5 s client timeout) — grace reduced to 5 s,
    client timeout raised to 30 s and documented;
  - **Modal/Drawer focus effect re-ran on every render** (inline `onClose` in the
    dep array), so typing the container name in the remove dialog kept only the
    first character; fixed with an `onCloseRef`;
  - status pills stretched across the whole cell (flex column default `stretch`);
  - uptime was always "—" because `listContainers` has no `StartedAt`;
  - on a 390px screen the row-actions column fell outside the visible table, so
    nothing could be controlled from a phone — the last column is now sticky.
- Cleaned up only my own `capturehost.test=true` containers; `beautiful_heisenberg`
  untouched (created 2026-08-05, still exited).
- `npm audit`: 0 vulnerabilities, both packages.

### 2026-11-08 — session 5
- Phase 4 shipped (229 tests, 13 files): container safety policy, git service,
  deployment pipeline, projects/deployments/env/webhook routes, live build-log
  socket, Projects + Project Detail pages.
- Real deploy of `Sidharth7082/capturehost-test-app`: clone → build → run → health
  check → live on `127.0.0.1:8101`, ~5 s warm, log captured in `deployments.log`.
- Verified in this session: correct HMAC accepted (202 + deployment), bad signature
  rejected (401), replay of the same `X-GitHub-Delivery` answered `duplicate`,
  rollback re-ran the previous image without rebuilding, `scripts/integration-deploy.mjs`
  green end to end, container inspect shows `privileged:false`, `CapDrop:ALL`,
  `no-new-privileges`, no binds/mounts/devices, loopback-only port, 512 MB / 0.5 cpu / 256 pids.
- Bugs found by running it, not by tests:
  - **`git clone` was given a path relative to its own cwd** → the clone landed in
    `destDir/destDir`, so the Dockerfile "did not exist" and the size read as 0 MB
    (cwd is now the parent, and the pipeline resolves `DEPLOY_DATA_DIR` to an absolute path);
  - **`cap_drop: ALL` alone killed nginx** (`chown("/var/cache/nginx/client_temp") failed`),
    which is why the capability allowlist exists at all;
  - **blue/green could not publish the same host port** ("port is already allocated"),
    so every deploy now takes a fresh port and the project's port follows the swap;
  - **a crash-looping container was reported healthy**, because it is briefly
    "running" between restarts — the health check now treats `Restarting` as failure
    and wants two stable samples;
  - the build log repeated `Downloading` hundreds of times (consecutive duplicates
    are collapsed), and the log viewer stayed on the old deployment after a deploy
    (it now jumps to the newest);
  - five tabs overflowed the 390px layout by 31px (tab strip scrolls).
- `npm audit`: 0 vulnerabilities, both packages. `tsc` clean, frontend `npm run build` green.

---

### 2026-11-08 — session 6
- Phase 5 shipped: `CaddyService` (admin client + reconciler), domain policy,
  migration 006, domain routes, `deploy/caddy/{Caddyfile,Caddyfile.public}`,
  Domains page + add-domain modal + Caddy banner, project overview URL.
- Live: Caddy 2.11.8 on `127.0.0.1:2019/8080/8090`; `hello.capturehost.localhost`
  returns the deployed app through Caddy, unknown host 404, redeploy and rollback
  keep the hostname answering, deleting the domain returns 404 again.
- Bugs found by running it:
  - the admin API answers **403 with an empty Origin**, so the client now sends
    `Origin: <adminUrl>`;
  - PUT on a route array is refused ("key already exists") and POST takes an
    **array** only when the list is missing — both fixed and covered by tests;
  - a `routes` list that exists but is empty answers **200**, so the 404
    catch-all had to move out of the Caddyfile and become a tagged route the
    backend appends last;
  - an empty request body (DELETE) crashed the JSON parser (`Unexpected end of
    JSON input`) and surfaced as a 500 — fixed;
  - a reload wipes API routes (demonstrated live: `routes: null`), and one domain
    PATCH restored them.
- `npm audit`: 0 vulnerabilities, both packages. 288 tests, `tsc` clean.

### 2026-11-08 — session 7
- Phase 6 shipped: encrypted backups (online snapshot + verify + restore + CLI),
  notification feed with dedupe/cooldown, SSRF-guarded outbound webhook,
  retention job, security doctor (CLI + API + page), systemd unit for option A,
  production compose for the proxy, README rewritten, `.env.example` complete.
- Live evidence: backup created (236.4 KB, sha256, integrity ok), verify ok with
  14 tables, restore refused while the server ran and succeeded into a scratch
  DB (14 tables, safety copy kept), doctor 13 pass / 3 warn / 0 fail, a stored
  notification suppressed a duplicate inside the cooldown, and a loopback
  `NOTIFY_WEBHOOK_URL` was refused as an SSRF target.
- Bugs found while running it:
  - the :8090 listener answered an empty 200 for foreign hosts (fixed with an
    explicit fallback site that returns 404);
  - the fd scan for `docker.sock` used `readFileSync` on `/proc/self/fd/*`,
    which blocks forever on a pipe — switched to `readlinkSync` (the doctor hung
    for minutes before this);
  - retention pointed at `audit_log.created_at` and `login_attempts.updated_at`,
    neither of which exists (`ts` and `last_at` do);
  - `.env` was mode 644 — the doctor caught it, `chmod 600` applied.
- 312 tests, `tsc` clean, `npm audit` 0, frontend build green.

## 10. How to resume (for the next agent)

1. Read this file completely.
2. `cd ~/capturehost && git log --oneline -5 && git status --short`.
3. `cd backend && npx vitest run` — must be green before changing anything.
4. Never restart a phase marked `[x]`; never start Phase N+1 before the user says
   "next" for Phase N.
5. Anything under `/api` is **authenticated by default** through the guard. A new
   public route must be added to `PUBLIC_ROUTES` in `middleware/auth.ts`
   deliberately — and to `PROTECTED_ROUTES` in `tests/auth-routes.test.ts` if it
   should be verified as closed. New sockets must call `authenticateUpgrade()`.
6. Docker work: keep it behind `DockerService` (never call dockerode from a route)
   and re-check the protected-container rule for anything destructive.
7. Update §1, §2, §7, §9 here at the end of every session, then commit.
