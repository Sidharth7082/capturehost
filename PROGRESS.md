# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update it at the end of every work session. Never leave it stale.

Last updated: 2026-11-09 (session 28 — databases: clone an existing one, or upload a dump)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 6 — backups, alerts, production: DONE**. All six phases built. |
| Verified state | 340 backend tests pass (18 files) + 21 launcher unit tests, `tsc` clean both packages, `npm audit` 0 vulns, real deploy of `Sidharth7082/capturehost-test-app` live on 127.0.0.1:8101, screenshots at 1440 and 390 — suite re-run in session 17 |
| Last commit | `b81aca0 feat(cli): change:password to rotate the admin password from a shell` |
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
| Caddy | 2.11.8 as a **user-local binary** `~/.local/bin/caddy` (not the pacman package) — admin `127.0.0.1:2019`, apps `:8080`, dashboard `:8090` |
| SQLite CLI | `/usr/bin/sqlite3` |
| Repo | `/home/capture/capturehost` |
| GitHub origin | `https://github.com/Sidharth7082/capturehost` — **public**, default branch `master`, remote `origin` |
| git identity | Sidharth7082 / sidharthkaushal558@gmail.com |
| Local dev admin | username `capture` (renamed from `sid` by `reset:admin` on 2026-11-08), **2FA off** |
| Shell alias | `capturehost` → `python3 ~/capturehost/capturehost.py`, in `~/.bashrc` |
| Pre-existing containers | `beautiful_heisenberg` (hello-world, exited) — **never touch** |

---

## 4. Running it (dev)

```bash
# first time only
cd ~/capturehost/backend && cp .env.example .env
openssl rand -base64 32        # paste into APP_ENCRYPTION_KEY
npm run setup:admin            # interactive; creates the only admin account

# every time — proxy, Caddy, backend and frontend in dependency order
cd ~/capturehost && python3 capturehost.py            # foreground, Ctrl-C stops it
python3 capturehost.py start -d                       # or in the background
python3 capturehost.py status | logs backend -f | stop

# launcher unit tests
python3 -m unittest discover -s tests -v              # 21 tests

# live docker check (touches only its own labelled container)
DOCKER_API_PASSWORD='…' node scripts/integration-docker.mjs
```

The manual equivalent, if the launcher is ever unavailable:

```bash
cd ~/capturehost && docker compose -f docker-compose.dev.yml up -d
cd ~/capturehost/backend  && npm run dev     # :8787, loopback only
cd ~/capturehost/frontend && npm run dev     # :5173, proxies /api + /ws
~/.local/bin/caddy run --config deploy/caddy/Caddyfile --adapter caddyfile
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

### Session 9 fixes
48. **Drift was compared as raw JSON.** Caddy (Go) returns maps with sorted keys;
    the builder writes them in source order, so `JSON.stringify` never matched and
    every 60 s sync "repaired" the routes by deleting and re-appending them —
    a sub-second 404 each time. `routeFingerprint()` canonicalises recursively and
    compares only what changes behaviour: tag, hosts, handlers, upstream dial, the
    proxy headers we set, and `terminal`.
49. **`writeRoutes` is now surgical**: unchanged routes are left in place, only
    missing/changed ones are deleted and re-appended, and the 404 catch-all is
    moved back to the end whenever anything was written.
50. **The disk check watches the data filesystem**, not `fsSize()[0]`: the mount
    containing `DB_PATH` (longest prefix match, so a sibling with a shared prefix
    does not match) is reported by name. Hysteresis: alert at 90 %, recovery only
    below 85 % (`NOTIFY_DISK_RECOVER_PCT`), with a `disk.recovered` notification.

### Session 14 fixes
51. **Deployment history is per project, not global.** A sidebar item labelled
    "Deployments" that opened nothing (and a `/deployments` route that opened an
    empty placeholder) claimed a page the app does not have; both are gone rather
    than left as a roadmap promise. A cross-project list wants a new
    `GET /api/deployments` and is only worth it with several projects deployed.

### Session 16 fixes
52. **The admin name is matched case-insensitively** (`WHERE username = ? COLLATE
    NOCASE`). `Sid` failing where `sid` works is indistinguishable from a wrong
    password: it burns a login attempt and five of them lock the IP — that is
    exactly how the owner got locked out. NOCASE folds ASCII only, which is the
    whole alphabet a name realistically uses; the column's BINARY `UNIQUE` index
    cannot be violated because there is exactly one row (`CHECK (id = 1)`), so no
    migration. The lockout key was already lowercased and the form now says the
    name is not case-sensitive.
53. **The router has a catch-all** (`<Route path="*" element={<NotFound />} />`
    inside the guarded layout) and `findPage()` returns a synthetic "Not found"
    title for paths that match nothing. Before this an unknown URL rendered the
    layout with an empty content area and the topbar still said "Dashboard" —
    which reads as a broken app rather than a broken link.
54. **`Dropdown` renders its menu in a portal with `position: fixed`,** positioned
    from the trigger's viewport rect. Every row menu sits inside a table wrapped in
    `overflow-x: auto`, and that is a clipping box for absolute children: the menu
    was cut at the table edge, gave the table its own scrollbar and scrolled the
    row out of view. Fixed positioning inside a portal escapes every ancestor
    overflow and stacking context; the cost is measuring the trigger and clamping
    the result — flip up when the space below is tight, keep 8px from every edge.
    It closes on outside pointerdown, Escape (focus back to the trigger), Tab,
    selection, scroll and resize, because measured coordinates die with a scroll.
55. **Focus lands during the same pre-paint pass that measures the menu**, so the
    menu is hidden with `opacity: 0`, never `visibility: hidden` — an invisible
    element cannot take focus and the first `focus()` is silently dropped.

### Session 17 (dev launcher)
56. **The launcher owns processes, not ports.** `.run/pids.json` records pid, pgid,
    cwd and a cmdline marker per service; anything not recorded is never signalled,
    and a recorded pid is re-verified (pid + marker + cwd) before any signal because
    a long session can recycle pids. `stop` and Ctrl-C act on what the file says we
    own — including a service this invocation *skipped* because it was already
    healthy from an earlier launcher run. `docker compose stop` is scoped to
    `docker-compose.dev.yml`, so deployed project containers and other containers
    are untouched.
57. **Zombies are not "alive".** In foreground mode the children are ours, so a
    SIGKILLed child stays in `/proc` until reaped and `killpg(pgid, 0)` keeps
    succeeding. The first version therefore waited its whole 10 s grace, sent
    SIGKILL to something already dead and printed "would not die" — and the whole
    shutdown took longer than the test harness allowed. `group_alive()` now reads
    `/proc/<pid>/stat` and ignores state `Z`, and `_reap()` waits on our own child.
58. **`Popen` can return before the child has exec'd**, and an unexec'd child has an
    empty `/proc/<pid>/cmdline` — `verify_pid` is then a false negative (the safe
    direction: we refuse to kill). Nothing in the flow verifies a pid at spawn time;
    the unit test waits for the cmdline to appear before asserting.
59. **A failed start never leaves half a stack.** A port held by someone else, a
    failed `compose up`, a service that exits during startup or is not healthy in
    time all run the same shutdown path, so a port conflict on the backend cannot
    leave Caddy holding `:2019` with nothing behind it. The offending process is
    named from `ss` and left running.

### Session 18 (toolbar + name/meta cell were never in the bundle)
60. **`styles/lists.css` is now global on purpose.** The Projects toolbar and the
    two-line name/meta cell were styled in `pages/Placeholder.css`, which only
    `PagePlaceholder` imports — and `PagePlaceholder` is only imported by
    `Databases.tsx`, which is not routed. Those rules therefore fell out of the
    module graph and never reached the bundle: the built CSS contained only the
    `.containers-page …` overrides. Symptom: the toolbar rendered as raw HTML (icon
    above an unstyled input, no gap before the button) and rows read
    `hello-capturehostSidharth7082/capture-host-test-app · main` on one line.
    Affected every list page, not just Projects: Containers, Domains, Backups,
    Notifications, Security, LogsDrawer, DeploymentLog, ProjectDetail.
61. **Page-specific CSS must be imported by the page that uses it; shared furniture
    belongs to a stylesheet `main.tsx` imports.** A stylesheet reachable only
    through a page nobody routes is dead code that *looks* alive, and the dev server
    hides it no better than the build does (same module graph) — this was not a
    build-only bug.
62. **A long name truncates instead of stretching the row**: `__name` is a single
    line with an ellipsis capped at 40ch, `__meta` at 46ch (wide enough for
    `owner/repo · branch`, narrow enough to keep the table from scrolling sideways).

### Session 19 (brand)
63. **The mark is drawn from measurements, not from the JPEG.** The brief named
    `frontend/public/brand/logo-mark.png`, which never existed; the assets turned up
    in `assests/` as three files arriving over ten minutes: `logo.jpg` (the simple
    early mark), then `Logo with text.jpg` and `Favicon set.jpg` (the real mark:
    thicker arms with **two holes each**, a thinner right section, and a lens dot in
    a scooped mouth). The last two are the brand kit and the geometry comes from
    them, measured by ImageMagick pixel sampling on a 512 grid, never by eye:
    arms 104..193 tall on the left and 104..172 on the right with a 34 radius end,
    middle bar 212..300 scooped to end at x228 by a circle r84 at (312,256), lens
    r40 at the same centre, holes r8.8 at x157/x198, ink 113..398 × 104..408.
64. **Two colour schemes, as in the kit.** `logo-mark-transparent.svg` is the
    gradient mark (bars `#6366f1 → #8b5cf6`, lens off-white `#f5f5f7`) cropped to a
    320-unit square around the ink — the UI version, used by the sidebar and login.
    `logo-mark.svg` puts the same mark at 62% on the `#161e31` brand navy (the "dark
    background" logo). `favicon.svg` inverts it like the reference tile: gradient
    `#5167ee → #8559f4` background, plain off-white mark, no holes (they dissolve at
    16px anyway). The lockup JPEG paints the lens violet; this follows the brief and
    the favicon, which both say off-white.
65. **`components/Brand.tsx` is the only place the lockup is built** — mark,
    "Capture" in `--text`, "Host" in `--accent` (#6366f1) — used by the sidebar
    (`Layout`) and the login card (`variant="login"`, stacked above the form). The
    `<img>` carries explicit `width`/`height` plus fixed CSS dimensions, so the rail
    reserves the box before the SVG decodes: measured CLS 0.
66. **Brand assets are static, so they live in `frontend/public/brand/`** (Vite
    copies them to `dist/`, Caddy serves `/brand/...`): `logo-mark.svg`,
    `logo-mark-transparent.svg`, `favicon.svg`, `favicon-32.png`,
    `apple-touch-icon-180.png`. The wide lockup is `docs/brand/header.svg` with a 2×
    `header.png` behind it, and the source JPEGs sit beside it
    (`docs/brand/logo-source.jpg`, `docs/brand/logo-lockup.jpg`,
    `docs/brand/favicon-source.jpg`) — the misspelled `assests/` directory is gone.

### Session 20 (icon set)
67. **The tab icon is a simplified mark, generated — not a shrunken copy.** The full
    mark (stepped arms, two holes per blade, r8.8) turns to mush below 32px, so
    `favicon.svg` uses three uniform blades 84 tall with 52 gaps on a 512 canvas,
    a bigger lens (r58) in a r100 mouth, no holes, and a 22% rounded tile. Every
    raster comes from that same vector, so the set cannot drift.
    A two-blade variant was measured at 16px and was **worse** (the mouth chopped the
    arms into a "3"); three blades stays.
68. **Full set, all generated from the vector** in `frontend/public/`:
    `favicon.svg` · `favicon.ico` (48/32/16) · `favicon-16x16.png` ·
    `favicon-32x32.png` · `apple-touch-icon.png` (180, full-bleed square) ·
    `icon-192.png` · `icon-512.png` · `icon-maskable-512.png` (mark at 80%, background
    full-bleed) · `site.webmanifest` (name/short_name CaptureHost, standalone,
    `#0b0d14` theme and background). `index.html` links ico → svg → png sizes +
    apple-touch + manifest, and the meta `theme-color` is now `#0b0d14` to match.
69. **Caddy needed one header rule for the manifest.** Caddy 2 has no `mime`
    directive and its table has no `.webmanifest` entry, so `/site.webmanifest`
    arrived with an **empty** Content-Type and Chrome refuses to install the app from
    a manifest served that way. Fixed with a path matcher +
    `header @manifest Content-Type application/manifest+json` in the dashboard site.

### Session 21 (empty-state illustrations)
70. **The illustrations are opaque navy cards, and are treated as such.** The six
    sources arrived as JPEGs (1184×864, no alpha channel), so "transparency" was
    not something to preserve — the art already carries its own dark background.
    They are converted to 480×350 WebP (2× of the 240px display size) and rendered
    inside a 14px rounded box with a hairline inset border, rather than pretending
    the背景 is transparent.
71. **`assetsInlineLimit: 0` in `vite.config.ts`.** Five of the six WebP files are
    under Vite's 4 KB default, so they shipped as base64 inside the JS bundle —
    bigger over the wire, no separate cache entry, no hashed filename. Forcing file
    output gives `assets/<name>-<hash>.webp` for all six.
72. **`EmptyState` takes an optional `illustration` and is the only empty-state
    component.** With an illustration it drops the small icon bubble; the image is
    decorative (`alt=""`, `aria-hidden="true"`, `loading="lazy"`) with explicit
    `width`/`height` attributes, so the box is reserved before decode and screen
    readers announce only the title and description. Search-with-no-results reuses
    the same component *without* an illustration: "No matches" plus a clear action.
73. **Copy is the brief's, and the Domains action reflects reality**: with no
    projects the `Add domain` button renders disabled with a title hint, because a
    domain has to point at something.

### Session 23 (public access through a Cloudflare Tunnel)
74. **The tunnel points at three loopback listeners, and the dashboard is not one
    of them.** `8080` (apps, wildcard ingress), `8081` (webhook gateway) and
    nothing else. `8090`/`8787`/`5173`/`2019`/`2375` are never ingress targets: the
    dashboard stays `http://capturehost.localhost:8090` on this machine.
75. **The gateway is its own Caddy listener, not a route on the apps listener.**
    Caddy can only *append* routes to a server, so a route written in the Caddyfile
    on `:8080` would either shadow every deployed site or publish `/api` on the port
    a tunnel exposes. A separate `hooks.<domain>:8081` site with `bind 127.0.0.1`,
    one `method POST` + `path_regexp ^/api/webhooks/github/[0-9]{1,20}$` matcher,
    `request_body max_size 1MB`, and a `respond 404` fallback keeps the blast radius
    at one path. A second `:8081` site answers 404 for other hostnames, because an
    unmatched site on a bound listener answers an empty 200 that looks like success.
76. **`CF-Connecting-IP` is believed only from a loopback peer.** `resolveClientIp`
    (`utils/clientIp.ts`) takes the peer from the socket, normalises
    `::ffff:127.0.0.1` and zone ids, and honours the header only when that peer is
    in `TRUST_PROXY_ADDRESSES`. A header carrying a list, a non-IP, or anything sent
    from a non-loopback source is ignored — otherwise one forged header picks
    somebody else's rate-limit bucket and can lock the real admin out. `X-Forwarded-For`
    is deliberately *not* read here; Fastify already handles it under `trustProxy`.
77. **Hostname rules for real domains: exactly one label, apex refused, six
    reserved names.** `app.captureordie.online` yes; `a.b.…` no; `captureordie.online`
    no; `www`, `hooks`, `capturehost`, `admin`, `dashboard`, `api` no, in every base.
    `localhost` keeps two labels because it is a TLD stand-in and the existing
    convention nests under `.capturehost.localhost` — breaking that would invalidate
    the live `hello-capturehost` domain for no security gain.
78. **`SESSION_COOKIE_SECURE=false` in tunnel mode is correct, not a mistake.** You
    log into the dashboard over plain HTTP on loopback; a `Secure` cookie is not sent
    over HTTP, so `true` locks the operator out of their own dashboard. The cookie
    never leaves the machine and the dashboard is never in the tunnel. Domain URLs in
    the dashboard are now decided per hostname, not per mode: public bases get
    `https://<name>` (no port), localhost names keep `http://<name>:8080`.
79. **The doctor's two exposure checks are listener-aware.** The apps listener may
    never dial a private port at all; a gateway listener may dial only `8787` (the
    API) and nothing else; routes on the dashboard port are out of scope, because
    `:8090 → :8787` is exactly what the dashboard is for. A blind
    "no route may reach 8787" rule would have warned about the dashboard forever.

### Session 25 (the public path, live)
80. **Cloudflare was configured through the API with a token the operator issued
    for the purpose** — never the account password, never the dashboard. Token
    scopes as issued: Tunnel:Edit initially, DNS:Read only; the wildcard record
    needed Zone·DNS·Edit, which the operator granted when the first attempt
    returned `10000 Authentication error`. What was written: the tunnel's remote
    ingress (version 0 → 1) and one wildcard CNAME. Nothing else — the apex A
    record (Hostinger) and `www` were left exactly as they were.
81. **The first public hostname was attached from a local CLI, not the dashboard.**
    `POST /api/domains` requires an admin session; the dashboard needs the admin
    password, which is never typed by the agent, and the browser tool refuses
    `localhost` URLs outright. The attachment therefore ran through the app's own
    code path from a one-off `tsx` script — `validateHostname` → `createDomain` →
    `writeAudit` (actor `local-cli (hermes)`) → `caddy.sync('domain-add')` — so the
    row, the audit trail and the route are the same ones the route handler would
    have produced. The script was deleted afterwards; it is not a second API.

### Session 26 (GitHub integration)
82. **The token is a row, not a service.** `integrations(name, token_encrypted, login,
    token_expires_at, connected_at, last_validated_at, last_error)` — one row per
    provider, encrypted with `APP_ENCRYPTION_KEY` and context-tagged. Nothing in the
    repository layer ever sees plaintext, so no repo function can leak one.
83. **GitHub is faked at `fetch`, never at the service.** `GithubService` takes an
    injectable `fetchImpl` and `now`, so every test in `tests/github.test.ts` runs
    without a network or a token, and the cache/expiry tests can move the clock
    instead of sleeping.
84. **The host is asserted twice.** The base URL is a constant, and `request()`
    re-parses the final URL and refuses anything that is not `https:` + `api.github.com`
    before the call. Redirects are `error`, not followed. That is what keeps "fixed
    host" true even if a future edit takes a base from config.
85. **Search is GitHub's, not ours.** `/user/repos` has no query parameter, so a
    non-empty query switches to `/search/repositories?q=<query> user:<login>`. Both
    paths page server-side and share the ETag cache, and a rate-limited answer
    becomes `429` + `Retry-After` from `x-ratelimit-reset` (or `retry-after`).
86. **Dockerfile checks are per selection, not per row.** `GET /repos/:o/:r/dockerfile`
    is called when a repository is selected — including a selection restored from
    above — so a 30-repo page costs one request, not thirty.
87. **Expiry is recorded, not discovered.** GitHub does not expose a PAT's expiry via
    the API, so the connect form takes an optional date; the 14-day warning and the
    doctor only fire when one was recorded, and the UI says "not recorded" otherwise
    rather than inventing a date.
88. **The clone credential is unchanged where it matters.** A per-project token still
    wins; the integration token is only the fallback, and it reaches git exclusively
    through the existing askpass helper. `tests/github-clone-token.test.ts` scans the
    deployment log, the audit log, the build arguments and the container config for
    the fixture token and asserts it appears in none of them.

### Session 27 (Phase 7 — databases)
89. **One mount exception, derived from the id.** Applications mount nothing; a
    database mounts exactly `capturehost-db-<its own id>:/var/lib/postgresql/data`.
    `buildDatabaseCreateOptions` never takes a path from input and
    `assertSafeDatabaseOptions` re-checks the finished payload — host binds, the
    docker socket, `:ro`/`:rw`, a second mount, another database's volume,
    privileged mode, devices and host namespaces all still throw. 18 policy tests.
90. **The proxy flags did not change.** `VOLUMES: 0`, `EXEC: 0`, `NETWORKS: 0` stay:
    Docker creates a named volume implicitly at container create, so nothing needed
    widening. The cost is that this process cannot delete volumes either — delete
    leaves `capturehost-db-<id>` behind, and the UI/response names the exact
    `docker volume rm` to finish the job.
91. **Postgres needs four capabilities, and that is a real finding.** With
    `CapDrop: ['ALL']` and no `CapAdd` the container crash-looped:
    `chown: /var/lib/postgresql/data/pgdata: Operation not permitted`. The image's
    entrypoint runs as root, chowns its data dir and `/var/run/postgresql`, then
    drops to uid 999 — that is `CHOWN`, `FOWNER` (chmod), `SETUID`, `SETGID`.
    Nothing broader is allowed, and none of it escapes the container.
92. **Backups are `pg_dump -Fc` in a helper container, not a host binary.** There is
    no `pg_dump` on this machine and no sudo to install one. The helper joins
    `capturehost-apps`, runs with `Entrypoint: ['pg_dump']` (the image's entrypoint
    prints to stdout, which is where the archive comes from), dials the database by
    container name on `-h/-p`, and the archive leaves on its stdout. Encrypted with
    `BACKUP_ENCRYPTION_KEY` before it touches disk.
93. **Restore never overwrites.** A restore creates a new database, waits until it
    accepts connections, uploads the archive as a one-file tar (`putArchive`) and
    runs `pg_restore ... /tmp/dump.archive`. The stdin route was tried first and
    abandoned: docker's stdio attach does not reliably deliver EOF, and `pg_restore`
    then blocks forever — observed as a helper container still running after four
    minutes with no output.
94. **`waitUntilReady` matters.** `docker start` returns when the process exists,
    which is seconds before initdb finishes. Create waits up to 45 s, restore up to
    90 s, both by polling a `select 1` through the `pg` driver.

### Session 28 (clone and import)
95. **Three ways to start a database, one rule about overwriting.** Empty, clone an
    existing CaptureHost database, or upload a dump. Cloning and importing both land
    in a **new** database; importing into an existing one is refused unless it has
    zero tables and the name is typed. The invariant "nothing overwrites data in
    place" survives the feature.
96. **Uploads stream to disk, they are not buffered.** `application/octet-stream`
    gets its own content-type parser (a limit that widens nothing that takes JSON),
    which pipes the request body to `data/backups/imports/<uuid>.upload`, counts
    bytes as they arrive and aborts at `DATABASE_MAX_UPLOAD_BYTES` (256 MB). A
    gzipped upload is decompressed server-side with its own byte cap, so a zip bomb
    is a 413.
97. **The format is decided by content.** `PGDMP` or a tar header → `pg_restore`;
    printable text → `psql -v ON_ERROR_STOP=1 -f`; anything else → 400. The file
    name is only a label (and audited after `basename()`), never a routing decision.
98. **A failed import removes the database it created.** `discard()` removes the
    container and the row, so a broken archive does not leave an empty "broken" shell
    behind for the operator to find later.

## 8. Known gaps / deliberate deferrals

- **`healthPath` is API-only.** The deploy pipeline honours it (a 2xx probe on the
  published port), but the project form never asks for one, so in the UI health is
  "the process was still running twice, a second apart". A project needing a real
  readiness URL has to set it through `PATCH /api/projects/:id`.

- **2FA is off on the admin by the owner's decision** (2026-11-08). The dashboard
  binds loopback only, so a strong password is the accepted bar for now and the
  doctor will keep reporting exactly one warn about it. Revisit at the moment
  anything is exposed beyond this laptop — Tailscale or any tunnel — where 2FA
  *and* `SESSION_COOKIE_SECURE=true` over HTTPS become prerequisites. With 2FA off
  there are no recovery codes: `reset:admin` is the only way back in.

- **No global Deployments page.** History is per project (Projects → a project →
  Deployments tab), which is enough while there is one project. The sidebar entry,
  the `/deployments` route and the placeholder page were removed in session 14;
  `PagePlaceholder` and the `ready`/`phase` nav mechanism stay (a `ready: false`
  item renders "Soon", and nothing uses it right now). `/deployments` now lands on
  the 404 page like any other unknown URL.

- **Phase 5 prerequisites (flagged by the user, do not forget):**
  - When Caddy sits in front, set `TRUST_PROXY=true`, otherwise every request
    arrives as `127.0.0.1` and the per-IP login lockout becomes one shared
    bucket — one wrong password locks the world out.
  - Set `SESSION_COOKIE_SECURE=true` the moment the dashboard is served over
    HTTPS (the cookie then also gains the `__Host-` prefix).
- `docker-compose.yml` for production — Phase 6 (dev compose exists).
- **The deployment queue is in memory** — a backend restart loses queued builds
  (the row stays `queued`; cancel it and deploy again).
- **Webhooks need a tunnel, and now have one.** The backend listens on 127.0.0.1, so
  GitHub reaches `/api/webhooks/github/:id` through the gateway on
  `hooks.<domain>` → `127.0.0.1:8081` (session 23), which forwards exactly that one
  path. A delivery from the real GitHub has not been observed yet — see §8a.
- **Only deploy repositories you trust.** Builds run arbitrary code from the
  Dockerfile (and the container runs it). There is no sandbox beyond the container
  policy yet.
- Failed image builds leave layer cache behind; `docker builder prune` occasionally.
- No per-project build args, no compose/multi-service projects, no Dockerfile
  generation — deliberate (Dockerfile required).
- Disk stat card has no sparkline.
- No "forgot password" by design: recovery is `npm run reset:admin` from a shell.
- Events that emit into the feed: deploy failed, scheduled backup failed, disk
  above threshold, Caddy unreachable, Caddy drift, managed container restart
  loop or unexpected exit, domain failing 3 checks in a row (and recovery),
  login lockout per IP, and 5+ rejected webhooks per project in 10 minutes.
  All of them go through the same dedupe key + cooldown.
- `npm run doctor` and the Security page are read-only by design.
- Light theme toggle and the disk sparkline were deliberately skipped (Phase 6
  says skip anything needing a new phase; both need design work on the token set).
- `public` mode is implemented but **untested** (needs a real domain and an
  inbound port); the README says so.
- No certificate probes yet in local mode (`https_ok` stays null until public
  mode is used).
- No container **create** or **exec** from the UI — deliberate (containers are only
  created by the deploy pipeline, which owns the safety policy).

### 8a. Built and unit-tested, but never exercised against the real thing

These are the honest edges of "complete". Each has tests around it, none has met the
outside world yet:

- **`CADDY_MODE=public`** (direct 80/443 + automatic HTTPS). Needs a real domain and
  an inbound port; the tunnel path is the tested one.
- **A real GitHub connect.** Every test fakes `fetch`. The first live `GET /user`
  through the integration is still to happen, so the token round-trip, the login in
  the UI and the expiry field are unproven against github.com.
- **A real webhook delivery.** The gateway answers correctly (401 unsigned, 404
  unknown project), but no signed push from GitHub has arrived:
  `webhook_deliveries` is at 0.
- **A private-repo clone through the integration token.** The plumbing is tested
  with a fake git; the first real `askpass` clone of a private repository is
  untested.
- **A restore from backup.** Backups are created and verified, the restore path is
  tested against a stopped backend, but a real "restore my live database" has not
  been done on this install.
- **Rollback after a genuinely broken commit.** Tested in the pipeline suite; not
  yet performed on a live deployment here.
- **A push-to-deploy loop** (webhook → build → swap) end to end on this machine.
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

### 2026-11-08 — session 8 (alerting)
- Wired the four alerting paths that only matter while away:
  `ContainerWatcher` (managed containers: restart loop, unexpected exit — polled
  every 15 s, inspect only when something looks wrong), `DomainMonitor`
  (consecutive-failure counter in SQLite, alert on the 3rd, alert on recovery,
  swept by the 5-minute health watcher), `AuthService.onLockout` (IP + window
  only), and `RejectionTracker` (5 rejections per project inside 10 minutes).
- Migration 008 adds `domains.consecutive_failures`, so a restart does not reset
  the counter. Manual and scheduled checks now both go through the monitor.
- 326 tests (14 new): restart loop, unmanaged ignored, running→exited, clean exit
  at startup stays quiet, 2 vs 3 domain failures, recovery, lockout payload has
  the IP and not the password, tracker window/project isolation/reset, and the
  route-level "5 bad signatures → exactly one notification".

### 2026-11-08 — session 9
- Fixed the repeating `caddy.drift`: fingerprint comparison (recursively sorted
  keys, headers included) and surgical route writes. Live check: 5 minutes of
  syncs with zero `caddy.drift_repaired` rows, zero drift notifications and zero
  non-200 responses on the deployed hostname.
- Disk alert now measures the filesystem holding the database/backups and has
  hysteresis (90 % up, 85 % down) plus a recovery notification.
- Docs: honest README intro (inspired by Coolify/CapRover, learning project, with
  limits stated) and `docs/DEMO.md`, a 7-minute script that mentions no secrets
  and touches only the test repo and scratch databases.
- Note for whoever reads this next: the 93 % → 77 % disk reading was a spike that
  nobody could account for; treat it as unexplained and keep watching.

### 2026-11-08 — session 10 (production install doc)
- `deploy/README.md` rewritten against the real sequence: stop the dev Caddy and
  dev servers, copy code **without** `backend/.env` or `backend/data`, build as
  the service user, generate fresh `APP_ENCRYPTION_KEY`/`BACKUP_ENCRYPTION_KEY`,
  create the production admin with `setup:admin` **before** the first start, then
  unit → proxy → Caddy → isolation checks → 2FA → first deploy → first backup →
  reboot test → retire the dev data.
- Env file is now `capturehost:capturehost` 600 inside a `root:capturehost` 750
  directory. As root-owned, no CLI run as the service user could read it —
  `setup:admin` and `npm run doctor` would both fail.
- **Unit bug found while reviewing it:** `IPAddressAllow=localhost` +
  `IPAddressDeny=any` filters the whole cgroup, so the `git clone` of a
  deployment would be dropped and every deploy would time out. systemd's filter
  is address-based, so "443 out" cannot be expressed; the filter is removed and
  the tradeoff documented in the unit and the README.
- Dev rotation of password/2FA deliberately skipped: production has its own
  database at `/var/lib/capturehost`, so account setup happens there.

### 2026-11-08 — session 11 (password check)
- `npm run check:password` — verifies a password against the stored argon2id hash
  with the same `verifyPassword()` the login uses, read-only on the database.
  Avoids the login form, where five attempts lock the IP for 15 minutes and raise
  a notification. Exit codes: 0 match, 1 no match, 2 no database/admin.
- README: "Forgot the password?" section with the production `--db` form.

### 2026-11-08 — session 12 (password rotation from the shell)
- `npm run change:password` — verifies the current password, applies the same
  strength check as the web form, rewrites only `password_hash`, revokes every
  session and writes an audit row. Keeps the account, its TOTP secret and its
  recovery codes (unlike `reset:admin`).
- `src/utils/prompt.ts` holds the hidden/visible prompt helpers that
  `setup-admin`, `check-password` and `change-password` now share — the same
  ~45 lines had been copied into two files.
- Verified on a scratch database: create → change → new password matches, old
  one does not, a session row is revoked, a wrong current password exits 1 with
  no change, a short password exits 1, and the audit log records both outcomes.

### 2026-11-08 — session 13 (state file + dev login)
- Header and §1 had been stale since session 10: "229 tests", "session 10",
  and a "Last commit" pointing at the phase-4 commit. Corrected to the measured
  state — `npx vitest run` 338 tests / 18 files green, `tsc --noEmit` exit 0 in
  both packages, HEAD `b81aca0`.
- Reported "Invalid username or password": all six failures in `audit_log` say
  `unknown username` (`capture` ×5, `capture-host` ×1), never "wrong password" —
  the account was **`sid`** at the time. `getAdminByUsername` compares with `=`, the
  `admin.username` column has no `COLLATE NOCASE`, so the name is case- and
  space-sensitive: `Sid` fails as surely as `capture-host`. The password was never
  actually tested.
- Those five misses had also tripped the per-IP bucket (`login_attempts`,
  `127.0.0.1`, locked to 20:28), so the correct credentials would have been
  refused as locked anyway. Rows cleared for `127.0.0.1` / `capture` /
  `capture-host` in `backend/data/capturehost.db`; that table is the live lockout
  state, so no restart was needed.
- Later the same evening the owner replaced the account (`admin.updated_at`
  20:26:46, new username **`capture`**, new argon2id hash, id still 1 so every
  session was dropped): `setup:admin` refuses when a row exists, so that path is
  `reset:admin`. Username and password now differ from the ones used in phases 1–6.
- `curl 127.0.0.1:8787/api/auth/setup-status` → `{"setupComplete":true}`, same
  through the vite proxy on :5173.
- `npm run doctor` on this state: **14 pass / 2 warn / 0 fail** — the warns are
  "2FA is off" and "development defaults in use" (`CADDY_MODE=local`), both
  expected on the dev copy.

### 2026-11-08 — session 14 (Deployments sidebar entry removed)
- Owner picked option A over a cross-project page: with one project, a global list
  is the project's Deployments tab plus a project column.
- Removed `NAV_PAGES` entry for `/deployments` (`navigation.ts`), the `<Route
  path="deployments">` and its import (`App.tsx`), and `pages/Deployments.tsx`
  (a `PagePlaceholder` with a hardcoded empty table and a `// Phase 4 fills this`
  comment). `PagePlaceholder` stays — `Databases.tsx` still imports it.
- Kept the `ready`/`phase` nav mechanism: `ready: false` still renders the disabled
  "Soon" chip and `CommandPalette` still prints `Phase N`, so the next roadmap item
  needs no new code. Nothing is `ready: false` today.
- Disk alert hysteresis deliberately **not** persisted (owner's call): after a
  restart the worst case is one extra `disk.high`, which costs less than a column.
- Verified: `npx vitest run` 338/338, `tsc --noEmit` exit 0 in both packages,
  `npm run build` 102 modules / 376.86 kB js / 54.31 kB css, and the running vite
  dev server serves `navigation.ts` and `App.tsx` with zero `Deployments` references
  (checked with `curl 127.0.0.1:5173/src/navigation.ts`).
- Not verifiable from here: the sidebar render and `/deployments` now showing an
  empty content area need a logged-in browser; the owner's session is in their
  browser and nobody should be typing that password into an agent.
- 2FA still off on the dev admin (`capture`) — the owner is doing it themselves.

### 2026-11-08 — session 15 (published to GitHub)
- Created `Sidharth7082/capturehost` (public) from this working tree and pushed
  `master`: the full history (16 commits through `9aa54df`, plus this state-file
  commit), branch now tracks `origin/master`.
  Description and eight topics set (self-hosted, hosting-dashboard, fastify, react,
  typescript, sqlite, docker, caddy).
- Pre-push audit before anything left the machine:
  - `git ls-files` had no `.env`, `*.db`, `*.chbk`, `data/`, `node_modules/` or
    `dist/`; `.gitignore` covers all of them;
  - `git grep` for `ghp_`/`github_pat_`/`gho_`/`AKIA`/`xox[baprs]-`/private-key
    headers across tracked files: no hits;
  - `git log -p --all` for a **filled** `APP_ENCRYPTION_KEY=`/`BACKUP_ENCRYPTION_KEY=`
    or a GitHub token: zero hits, so no secret is buried in an earlier commit;
  - `backend/.env.example` ships both key lines **empty**.
- Verified on the remote, not locally: tree of `master` = 226 entries with no
  secret/db/binary paths, `raw.githubusercontent.com/.../README.md` returns the real
  19,367-byte README, `PROGRESS.md` 674 lines, `backend/package.json` name
  `capturehost-backend`, and `backend/.env` answers **404**.
- Public was the owner's habit for portfolio repos (15 of 23); `gh repo edit
  Sidharth7082/capturehost --visibility private` flips it in one command if not.

### 2026-11-08 — session 16 (login casing, 404 page, row-menu clipping)
- `f6b88f5` — **case-insensitive admin login** (`getAdminByUsername` uses `= ?
  COLLATE NOCASE`) plus a hint under the username field ("Not case-sensitive —
  any casing of your admin name works."). Two new tests: `Admin`/`ADMIN`/`aDmIn`
  all log in and report the *stored* name, and a mixed-case wrong password lands
  in the single lowercase lockout bucket. No route changes.
- `f6b88f5` — **404 page**: `pages/NotFound.tsx` (EmptyState + "Back to
  dashboard") on `<Route path="*">` inside the guarded layout; `findPage()` now
  returns a synthetic `Not found` topbar title for unknown paths instead of
  falling back to "Dashboard".
- **Row-menu clipping fixed in `components/Dropdown.tsx` + `.css`** (the shared
  component, so Domains, Containers, Projects and the header account menu all
  inherit it): portal to `<body>`, `position: fixed` from the trigger's rect,
  flip up when the space below is tight, clamp 8px inside the viewport, close on
  outside pointerdown / Escape / Tab / selection / scroll / resize, focus into the
  first item on open and back to the trigger on Escape.
- **Bug hit while verifying, worth remembering:** the first version used
  `visibility: hidden` for the pre-measurement render and focused the first item
  from a passive `useEffect`. Focus silently never moved — an invisible element
  cannot take focus — so arrow keys did nothing while the menu looked fine.
  Fixed by focusing inside the same `useLayoutEffect` that measures and using
  `opacity: 0`; confirmed with real keyboard events afterwards.
- Verified in a real browser (Chromium via CDP), at 1440×900 and 390×844, against
  a temporary `__UiHarness` route (real `DataTable` + `Card` + `Dropdown`, no auth,
  deleted before the commit — `grep UiHarness` is empty):
  menu parent is `<body>`, computed position `fixed`, menu 176px wide inside the
  viewport at both widths, `data-table` **not** scrolling vertically, page
  `scrollWidth - clientWidth === 0`, near the bottom the menu reports
  `data-side="top"` with its bottom at 795 against a trigger top at 801, and
  ArrowDown/ArrowUp/Home/End walk the three items.
- Not verified by me: the authed Domains/Containers pages themselves (that needs
  the owner's session — no password is typed into an agent). The harness renders
  the same components in the same `Card flush` + `DataTable` markup; the owner
  clicks the real row menu.
- Gates: 340 tests, `tsc` clean both packages, `npm run build` 103 modules.

### 2026-11-08 — session 17 (one-command dev launcher)
- `capturehost.py` at the repo root: `start` (foreground multiplexed logs, or
  `--detach`), `stop`, `restart`, `status`, `logs <service> [-f]`, `doctor`,
  `open`, plus `--no-frontend` and `--prod` (a pointer to systemd, not a mode).
  Stdlib only; every child is an argument list with an explicit cwd and its own
  session; no sudo, no shell.
- Start order proxy → Caddy → backend → frontend, each gated on a health probe
  (`/_ping`, `/config/` with the Origin header the admin API requires,
  `/api/health`, then port 5173) with per-service timeouts.
- Logs in `.run/logs/<service>.log`, rotated at 5 MB; `.run/` and `__pycache__/`
  added to `.gitignore`.
- Real run on this machine, in order:
  - swept 9 leftover dev processes from earlier sessions (five orphaned
    `npm run dev` backend chains included) — matched by cmdline/cwd against this
    repo only, so nothing unrelated was touched;
  - `status` from stopped → four rows `stopped`;
  - `start --detach` → proxy, Caddy, backend, frontend all `healthy` in one pass;
  - `status` → `running` with pids 1275603/1275626/1275723; `curl` 200 on
    `/api/health`, vite `/`, and `capturehost.localhost:8090` through Caddy;
  - `start --detach` again → four `skip` lines, still 3 leaf processes (no dupes);
  - `stop` → all four stopped, **0** surviving `node`/`caddy` processes,
    ports 8787/5173/2019/8090/8080 free;
  - `docker ps -a` before/after: `capturehost-hello-capturehost-25` still **Up**
    (a deployed project), `beautiful_heisenberg` untouched, only the socket proxy
    was stopped — by `compose stop` for our file.
- Failure modes exercised:
  - **Ctrl-C in the foreground**: `timeout -s INT` at 14 s → exit 130, wall 14 s,
    all four stopped in reverse order (`frontend`, `backend`, `caddy`, `proxy`).
  - **Port conflict**: `python3 -m http.server 8787` (not ours) → `fail backend:
    port 8787 is held by python3 (pid 1274222), which this script did not start`,
    Caddy and the proxy rolled back, exit 1, squatter still answering 200.
  - `status` reports that case as `foreign` with the owner, not `stopped`.
- Unit tests: 21 (`unittest`, no deps) covering port checks, health waits with
  timeouts, pid verification (incl. a dead pid, a recycled-marker pid and compose
  entries), log rotation, the state file, and the service definitions
  (loopback-only probes, no shell metacharacters in argv).
- Two bugs found by running it, not by reasoning: the zombie/`killpg` loop above
  (decisions 57) and the `Popen`-before-exec window (58).
- Gates: 340 backend tests, 21 launcher tests, `tsc` clean both packages,
  frontend build 103 modules.
- Docs: README now carries the launcher as a reference — command table, start order
  with the probe and timeout per service, the guarantees, the deliberate
  non-goals, plus `capturehost.py` and `tests/` in the Layout block and a one-line
  pointer in the intro. The alias in the README and in `~/.bashrc` are the same
  `python3` form.

### 2026-11-08 — session 18 (Projects toolbar and row cell were unstyled)
- Reported from the screenshot at `capturehost.localhost:8090/projects`: the search
  icon sat above an unstyled input that touched "New Project", and the row read
  `hello-capturehostSidharth7082/capturehost-test-app · main` on one line.
- **Root cause, not a build problem:** `.page-toolbar*` and `.cell-primary*` were
  defined in `pages/Placeholder.css`, imported only by `PagePlaceholder`, which is
  imported only by the unrouted `Databases.tsx`. The rules never entered the module
  graph, so neither the dev server nor the build had them — the built CSS contained
  only the `.containers-page …` overrides (`grep` on
  `dist/assets/index-DlTbheZl.css` returned 1 hit each, both overrides).
- Fix: `styles/lists.css` holds the toolbar and the name/meta cell, imported once in
  `main.tsx` after `layout.css`; `Placeholder.css` keeps only `.page-placeholder*`
  and its three unused `.settings-*` rules are gone.
- Blast radius (all fixed by the one move): Containers, Domains, Backups,
  Notifications, Security, `containers/LogsDrawer`, `projects/DeploymentLog`,
  `ProjectDetail` and `Projects` all use `page-toolbar` and/or `cell-primary`.
- Long values: `__name` truncates at 40ch, `__meta` at 46ch — the meta cap was 34ch,
  which cut `Sidharth7082/capturehost-test-app · main` in half.
- Verified without the owner's password, in a real browser at 1440×900 and
  390×844, using a temporary `__LayoutFixture` route (real `Card`/`DataTable`/
  `Button`/`Icon`/`StatusPill` and the same class names, one short and one
  48-character project name, deleted before the commit — `grep __LayoutFixture` is
  empty): icon inside the search box, search 320px wide with a 607px gap to the
  button at 1440 (wraps below it at 390), `.cell-primary` computed `display:flex;
  flex-direction:column`, name above meta (y 125→145 over 146→163), long name and
  meta both `scrollWidth > clientWidth` (ellipsis), page
  `scrollWidth - clientWidth === 0` at both widths.
- Verified the shipped artifact: `npm run build` → `dist/assets/index-Cnq-Cstx.css`
  contains `.page-toolbar{…display:flex…}` and `.cell-primary{flex-direction:column…
  display:flex}`, and `dist/index.html` references that hash. Caddy serves `dist`
  from disk, so no restart is needed — the CSS filename changes with the build.
- Gates: 340 backend tests, `tsc` clean both packages, build 104 modules.

### 2026-11-08 — session 19 (logo: SVG, sidebar, login, favicon, docs)
- The brief's `frontend/public/brand/logo-mark.png` did not exist and no such file
  existed anywhere on the machine; the assets arrived in `assests/` as
  `logo.jpg`, then `Logo with text.jpg` and `Favicon set.jpg` mid-session. The first
  measurement pass was against the simple early mark and was thrown away: the two
  later files are the real mark (arms with two holes each, a thinner right section
  and a lens in a scooped mouth), so the SVG was rebuilt from those.
- Assets: `frontend/public/brand/{logo-mark,logo-mark-transparent,favicon}.svg`,
  `favicon-32.png`, `apple-touch-icon-180.png` (rsvg-convert),
  `docs/brand/header.{svg,png}`. Sources moved to `docs/brand/`.
- `components/Brand.tsx` + `Brand.css` replace the "CH" badge in the sidebar and
  the badge+text block on the login card (now stacked above the form); the old
  `.sidebar__logo/.sidebar__name/.login-brand__logo/.login-brand__name` rules are
  gone and `.brand__name` took `.sidebar__name`'s place in both collapsed-rail rules
  (hidden in the rail, kept in the mobile drawer). `index.html` gained the three
  icon links and `theme-color #161e31`.
- Verified without the owner's password (the login page is public; a throwaway
  `__BrandFixture` rendered the real `.shell`/`.sidebar`/`Brand` markup and was
  deleted before the commit): rail 240px → brand 215×54, mark 30×30; collapsed rail
  64px → mark 30×30 centred, name and version `display:none`; "Host" computes
  `rgb(99,102,241)`; login mark 44×44 above the first field at 1440, and at 390 the
  card is 358 wide with `scrollWidth − clientWidth = 0`; layout-shift score 0 at
  both widths; `/brand/*` answers 200 with the right content type on :5173 and
  through Caddy on :8090, and the built login page loads the mark
  (`naturalWidth 320`, `complete: true`).
- Not verified by me: the sidebar inside the logged-in app at 390 (drawer) — the
  fixture covered the rail and the CSS rule, not a real drawer session.
- Gates: 340 backend tests, `tsc` clean both packages, build 106 modules.

### 2026-11-09 — session 20 (icon set from the vector mark)
- The brief's Leonardo pipeline assumed a raster `icon-1024.png`; there is no
  raster art in this repo (all marks are SVG), so the set was generated from
  `favicon.svg` instead — same artwork, no tracing step.
- New: `favicon.svg` (bolder tab variant), `favicon.ico` (48/32/16 in one file),
  `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180 full-bleed),
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `site.webmanifest`.
  `index.html`: ico/svg/png/apple-touch/manifest links, `theme-color #0b0d14`,
  apple app title. The old `brand/{favicon.svg,favicon-32.png,
  apple-touch-icon-180.png}` are gone — one place for icons now.
- `deploy/caddy/Caddyfile`: `header @manifest Content-Type application/manifest+json`
  (Caddy 2 has no `mime` directive; the first attempt failed `caddy validate` with
  "unrecognized directive: mime" and was replaced). Reloaded with
  `caddy reload --config deploy/caddy/Caddyfile`; the deployed demo app still
  answers 200 through the apps listener afterwards.
- Verified by HTTP, not by eye: every file answers 200 with the right content type on
  the dev server **and** through Caddy on :8090 — favicon.ico
  `image/vnd.microsoft.icon` / `image/x-icon`, svg `image/svg+xml`, pngs
  `image/png`, manifest `application/manifest+json` (empty before the Caddy fix).
  Static files are served by Vite/Caddy directly, so the auth guard never sees them;
  the backend's helmet CSP applies to `/api` responses only, and `img-src 'self'`
  would allow them anyway.
- Legibility, measured as pixels rather than claimed: 64px shows the three blades and
  the lens clearly; 32px still reads as a C with a dot; **16px resolves into three
  white bands with two small blobs in the middle row** — readable as this app's tile,
  not as a C. That is the floor for a three-blade mark at 16px, and the two-blade
  alternative was worse.
- Gates: 340 backend tests, `tsc` clean both packages, build 106 modules.

### 2026-11-09 — session 21 (empty-state illustrations)
- The art was not where the brief said: no `brand-incoming/empty/`, no PNGs of those
  names. The six JPEGs were sitting in `frontend/dist/assets/` (a build directory
  Vite empties on every build). Copied to `brand-incoming/empty/` first, then
  converted — `brand-incoming/` is now in `.gitignore`, and the build reads only
  `frontend/src/assets/empty/*.webp`.
- Conversion (ImageMagick, `-resize 480x -quality 80 -define webp:method=6`):

      404, page not found.jpg              72.9 KB ->  4.6 KB   not-found.webp
      Containers, empty.jpg                 50.6 KB ->  2.8 KB   containers.webp
      Projects, empty.jpg                   50.9 KB ->  1.6 KB   projects.webp
      Domains, empty.jpg                    44.7 KB ->  2.6 KB   domains.webp
      Backups, empty.jpg                    42.2 KB ->  1.9 KB   backups.webp
      Notifications, all caught up.jpg      36.2 KB ->  1.7 KB   notifications.webp
      total                                297.5 KB -> 15.1 KB   (all 480x350)

- Wired: Projects, Containers, Domains, Backups, Notifications, 404 (illustration +
  the brief's copy) and a no-results state on Projects and Containers ("No matches"
  + clear action, no illustration).
- Verified without a password and without touching real data: a temporary
  `__EmptyFixture` route rendered the real `EmptyState` with the real assets at
  1440 and 390, then was deleted (`grep __EmptyFixture` is empty). Nothing read or
  wrote the database; the fixture renders constants only.
  - six illustrations, all 240×175 CSS from 480×350 attributes at 1440, and 180×131
    at 390; `scrollWidth - clientWidth = 0` at both widths;
  - accessibility tree contains **no image nodes at all** (decorative), and the
    titles come through as text ("No projects yet", "Page not found", "No matches",
    "No backups yet", "No domains attached");
  - focus order is DOM order and skips the disabled control: New project →
    Go to Projects → Back up now → Back to dashboard → Clear filters; the images are
    not focusable.
- Served: all six hashed WebP answer 200 `image/webp` through Caddy on :8090; the
  dashboard HTML still carries **no** CSP, and the backend's CSP keeps
  `img-src 'self' data:` — nothing was loosened.
- Known inconsistency to decide on: the Domains illustration is drawn on a **light**
  background while the other five are navy, so it reads as a white card in the dark
  UI. Also, the marks sit small inside their 4:3 cards at 240px.
- Gates: 340 backend tests, `tsc` clean both packages, build 112 modules, `npm audit`
  0 vulnerabilities.

### 2026-11-09 — session 22 (guide: adding and running your own project)
- New `docs/ADD-YOUR-PROJECT.md` — the operator's path from "I have a repository"
  to "it answers on a hostname", written against the code rather than the intent:
  - the four prerequisites table (HTTPS GitHub repo, a Dockerfile, the app bound to
    the declared container port on 0.0.0.0, no persistent writes since no volumes
    are ever mounted);
  - the create form field by field with its real defaults (branch `main`,
    Dockerfile path `Dockerfile`, container port `80`, memory 512 MB, CPU 0.5) and
    the real limits (4096 MB, 4 CPU, 256 pids fixed);
  - the deploy state machine with what each failure means, blue/green semantics and
    cancellation;
  - hostnames: `*.localhost` in local mode, reachable at the Caddy apps listener
    `:8080`, HTTP only, and what happens on delete;
  - env vars are write-only and apply on the next deploy; webhooks need a tunnel;
  - rollback reuses the image (no rebuild) and keeps the last 3 images;
  - what the container cannot do (no privileged/host net/binds/devices/socket, four
    capabilities only) and the practical consequences (nginx needs all four);
  - a troubleshooting table using the pipeline's own error strings
    (`No Dockerfile at "…" in this repository`, `Container is in a restart loop`,
    `Health check did not pass within 30s`);
  - two minimal Dockerfiles (static nginx, Node) and the worked example that already
    exists here (`hello-capturehost`).
- Linked from the README deploy section and from `docs/DEMO.md`.
- Writing it surfaced a real gap, now in §8: **`healthPath` is exposed by the API and
  honoured by the pipeline, but the project form never asks for it**, so health is
  effectively "process stayed up". Worth a form field when someone needs it.

### 2026-11-09 — session 23 (public access through a Cloudflare Tunnel)
- **Client IP.** New `utils/clientIp.ts` + wiring in `routes/auth.ts` (session meta,
  so login lockouts key on the real client) and `routes/webhook.ts` (rate limit,
  rejection alerts). 12 unit tests, including "a spoofed header from another source
  is ignored" and "a header naming 127.0.0.1 from elsewhere is ignored".
- **Hostname rules.** `RESERVED_LABELS` (www, hooks, capturehost, admin, dashboard,
  api), apex refusal with its own message, and `maxLabelsUnderBase` (1 for real
  domains, 2 for `localhost`). 8 new tests in `domains.test.ts`.
- **Webhook gateway.** `deploy/caddy/Caddyfile` gained a `hooks.captureordie.online:8081`
  site (loopback, one path, 1 MB, 404 fallback) plus a `:8081` wrong-host 404.
  Verified with `caddy validate` and a reload, then by probe:

      POST /api/webhooks/github/1        Host: hooks…            401  (reached Fastify)
      GET  /api/webhooks/github/1        Host: hooks…            404
      POST /api/webhooks/github/abc      Host: hooks…            404
      POST /api/webhooks/github/1/extra  Host: hooks…            404
      POST /api/auth/login               Host: hooks…            404
      GET  /api/health                   Host: hooks…            404
      POST /api/webhooks/github/1        Host: capturehost…      404
      POST /api/webhooks/github/1        Host: evil.example      404
      POST /api/webhooks/github/1        2 MB body               413

- **Private parts stay private.** Probes on the apps listener with foreign Host
  headers: `capturehost.localhost` `/`, `/api/health`, `/api/domains`, `/ws/metrics`
  → all 404; `random-name.captureordie.online` → 404; `hooks.…` → 404; while
  `hello.capturehost.localhost` → 200 (control). On the dashboard port any host but
  `capturehost.localhost` → 404.
- **A transient worth knowing about:** reloading the Caddyfile replaces the whole
  config, so the backend's tagged routes *and* its 404 catch-all disappear until the
  next sync (up to `CADDY_SYNC_INTERVAL_MS`, 60 s). During that window the apps
  listener answers **empty 200s** for everything — including `/api/health` — which
  looks like success to a scanner. It is not a leak (nothing is proxied) but it is
  the reason the catch-all exists, and the doctor reports the drift meanwhile.
- **Doctor.** `public-private-upstreams` (apps listener: no private dials; gateway:
  8787 only; dashboard listener out of scope), `tunnel-targets` (parses
  `~/.cloudflared/config.yml` when present and warns on a private port target),
  `public-domain-2fa` (warn while a public base domain is configured and 2FA is off).
  Live run: 14 pass, 3 warn, 0 fail, 2 skipped; the two new public checks skip
  because this machine is still `CADDY_MODE=local`.
- **Docs.** README gained "Publish apps on your own domain": the exact `.env` block
  with the reasoning for each value, the hostname rules, the threat model (public
  apps, laptop must stay awake, dashboard never in the tunnel, 2FA stops being
  optional), the Cloudflare side as commands the operator runs (install, login,
  create, `tunnel route dns`, ingress yaml, user service), the priority table, the
  DNS record, an explicit "must not be created" list, a listener table, verification
  commands, and how to turn public access off (`systemctl --user stop cloudflared`).
  `.env.example` carries the same block as comments.
- **Gates.** 380 backend tests / 20 files, launcher 21, `tsc` clean both packages,
  frontend build 112 modules, `npm audit` 0 vulnerabilities.

### 2026-11-09 — session 24 (tunnel mode on; corrections from the operator's review)
- **`.env` switched to tunnel mode** (the six keys were absent, so defaults were in
  force): `CADDY_MODE=tunnel`,
  `ALLOWED_BASE_DOMAINS=localhost,captureordie.online`,
  `WEBHOOK_PUBLIC_HOST=hooks.captureordie.online`, `TRUST_PROXY=true`,
  `TRUST_PROXY_ADDRESSES=127.0.0.1,::1`, `SESSION_COOKIE_SECURE=false`. `.env` stayed
  mode 600; values were not printed. Restarted with the launcher (never a manual
  Caddy reload — that drops the managed routes and the catch-all for up to a minute).
- Live in tunnel mode: dashboard `:8090` 200, `hello.capturehost.localhost` 200,
  `capturehost.localhost` on `:8080` 404, gateway `hooks.` on `:8081` 401 for the one
  allowed path and 404 for everything else. Doctor: 15 pass, 3 warn, 0 fail, 1 skip.
- **Hostname rules verified against the real config** (not just unit tests):
  `demo.captureordie.online` and `hello.captureordie.online` accepted; the apex,
  `a.b.captureordie.online` and all six reserved names refused with their specific
  messages; `hello.capturehost.localhost` still accepted; `capturehost.localhost`
  refused.
- **Correction 1 — the 2FA reminder was overstated.** "One password is the only
  barrier between the internet and an admin session" is false in this design: the
  dashboard login is never routed through the tunnel, so the internet cannot reach
  it. The check still warns (it is a reminder, not a failure) but now says the truth:
  fine while the dashboard stays on loopback, and it becomes the barrier the moment
  someone adds a route to `8090`. README threat-model point 6 rewritten the same way.
- **Correction 2 — `tunnel-targets` can never see a dashboard-managed tunnel.** It
  now also reads `/etc/cloudflared/config.yml` (where `cloudflared service install`
  and the token-based service put it), and when neither file exists the skip says
  exactly why: routes created in the Cloudflare dashboard live in the account and
  cannot be checked locally — review the Routes tab. This install has
  `/etc/cloudflared/token` and no config file, so the check skips by design.
- **README §4 restructured** into the two real paths: **A** dashboard-managed tunnel
  (this install — routes in Cloudflare, `sudo systemctl stop cloudflared` as the off
  switch, doctor note), **B** CLI-created tunnel (config.yml, user service). Both
  carry the same route order (hooks before the wildcard), the same DNS record and the
  same "must not be created" list.
- **State of the public side at the end of this session** (checked, not assumed):
  `captureordie.online` resolves to Cloudflare (`104.21.66.37`, `172.67.155.218`) and
  the tunnel id `412ae24c-…cfargotunnel.com` resolves to `fd10:aec2:5dae::`, so the
  zone is Active and the tunnel exists. But `hooks.captureordie.online` and
  `anything.captureordie.online` do **not** resolve yet: the two routes and the
  wildcard DNS record have not been created. All three verification curls therefore
  fail at DNS resolution (`000`), not with an HTTP status — they will answer 404 once
  the routes exist.
- Gates: 380 backend tests / 20 files, `tsc` clean both, build 112 modules, audit 0.

### 2026-11-09 — session 25 (public path live)
- **Tunnel ingress** set via `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations`:
  `hooks.captureordie.online` → `http://127.0.0.1:8081`, `*.captureordie.online` →
  `http://127.0.0.1:8080`, catch-all `http_status:404`. Stored version 1, source
  `cloudflare`; tunnel `capturehost` (`412ae24c-…`) healthy with 4 connections.
- **DNS**: `CNAME *.captureordie.online → 412ae24c-….cfargotunnel.com`, proxied,
  id `32a06ef3f0ecd353ac6a9951d07128b9`. Zone state after: apex `A 2.57.91.91`
  (unchanged), `www` CNAME → apex (unchanged), wildcard → tunnel (new).
- **`demo.captureordie.online` attached** to project `hello-capturehost` (domain
  id 6), audit actor `local-cli (hermes)`.
- **Verified end to end, over the public internet, not just locally:**
  `https://demo.captureordie.online/` → **200** serving "CaptureHost test app";
  TLS `CN=captureordie.online`, Let's Encrypt, 2026-11-08 → 2027-02-06;
  `https://demo.…/api/health`, `/api/domains`, `/ws/metrics` → **404** each;
  `https://hooks.…/` and `/api/health` → 404; `POST https://hooks.…/api/webhooks/github/1`
  → **401** (reached Fastify, rejected for a missing GitHub signature);
  `https://anything.…` → 404 via Caddy's catch-all. Local
  `hello.capturehost.localhost` still 200; the domain monitor recorded a check
  for the new hostname with no error and 0 consecutive failures.
- **Local resolver negative cache** (NXDOMAIN from before the record existed) made
  plain `curl`/the browser on this laptop still claim the hostnames do not exist
  for up to the SOA TTL; authoritative DoH answers were correct throughout. Fix:
  `sudo resolvectl flush-caches`.
- Operationally: the domain was attached while the backend was running, and the
  reconciler pushed the route on the spot (`added: 1`) — no restart needed.

### 2026-11-09 — session 26 (GitHub integration)
- **Backend.** Migration `009_integrations.sql`; `db/integrations.repo.ts`;
  `services/github.ts` (status/connect/disconnect/listRepos/hasDockerfile, ETag cache,
  rate-limit mapping, 401 alerting, expiry reminder); `routes/github.ts`
  (`/api/github/status`, `POST /connect`, `DELETE /disconnect`, `GET /repos`,
  `GET /repos/:owner/:repo/dockerfile`, all `requireAuth` + per-session limiter, CSRF
  from the global hook); wiring in `app.ts`; `deployments.ts` gained
  `integrationToken` with project-token precedence; doctor check `github-integration`.
  Config: `GITHUB_API_TIMEOUT_MS`, `GITHUB_CACHE_TTL_MS`, `GITHUB_REPOS_PER_PAGE`,
  `GITHUB_TOKEN_WARNING_DAYS`.
- **Frontend.** `api/github.ts`; `Settings → Integrations · GitHub` card
  (connect/disconnect, login, expiry pill, last-validated, endpoint, errors);
  `GithubRepoPicker` (debounced search, paged list, private/fork/archived badges,
  selection reveal, lazy Dockerfile line, not-connected / expired / rate-limited /
  no-results states); `NewProjectModal` tabs **From GitHub** / **Paste URL**, with
  selection filling repo URL, branch and a suggested name.
- **Tests (33 new, 3 files).** `github.test.ts` (16) — connect/validate/encrypt,
  listing, paging, search, ETag 304, 403→429, 401→alert, malformed payload,
  not-connected, dockerfile, expiry notifications. `github-routes.test.ts` (14) —
  401 for every route, CSRF on connect/disconnect, no token in any response, expiry
  validation, owner/repo validation, 429 at the session budget.
  `github-clone-token.test.ts` (3) — integration token reaches git only, per-project
  token wins, nothing leaks into log/audit/build args/container; added the five routes
  to the all-routes 401 loop.
- **Screenshots** of the Integrations card and the From GitHub picker at 1440 and 390
  with mocked data (`window.fetch` shim + fixture route, both deleted before the
  commit), e.g. `~/.hermes/cache/scratch/shots/github-{1440,390}.png`.
  Gotcha worth remembering: `chrome --headless --window-size=390` renders at
  **500 px** and crops, which reads as horizontal overflow. Measured with
  `Emulation.setDeviceMetricsOverride` instead: `clientWidth 390 = scrollWidth 390`,
  no overflowing elements. The stacked-row media query stayed anyway — it is right
  for real phones.
- Gates: 413 backend tests / 23 files, launcher 21, `tsc` clean both packages, build
  117 modules, `npm audit` 0 in both packages.

### 2026-11-09 — session 27 (Phase 7: databases)
- Migration `010_databases.sql` (databases + project_databases), `db/databases.repo.ts`,
  `services/databasePolicy.ts`, `services/databases.ts`, `routes/databases.ts`,
  wiring in `app.ts` (service, routes, 6-hourly backup scheduler, log reader).
  New deps: `pg` + `@types/pg`.
- 19 routes, all session-required, writes CSRF-protected by the global hook, 20
  actions/minute per session: list, create, get, start, stop, restart, delete
  (name-confirmed, stopped and unlinked only), metrics, logs, tables, rows, query,
  link, unlink, backups list/create/delete/restore.
- **Database containers are protected in the generic Containers page** — the label
  `capturehost.database` makes `isProtected()` refuse start/stop/restart/remove
  there, so the volume-owning containers can only be touched from the Databases
  page.
- Doctor: `databases-safe` (volume derived from the id, published ports inside the
  app range) and `databases-backups` (nothing running without a recent snapshot).
  Live: "no databases yet".
- Frontend: `api/databases.ts`, a real **Databases** page (list, empty state, New
  database modal with version allowlist and the loopback-publish toggle), a
  **DatabaseDetail** page with Overview (status, size, connections, connection panel
  with copy buttons, one-time password panel), Data (table browser + SQL editor),
  Backups (create/delete/restore), Linked projects, Logs and Danger zone. Sidebar
  grouping became explicit (`section: host|network|system`) instead of index slices;
  Databases sits under **Network**.
- **Real evidence, not mocks:** `DATABASE_INTEGRATION=1 npx vitest run
  tests/database-integration.test.ts` starts a real `postgres:16-alpine`, writes two
  rows, dumps them, restores into a second database and reads `hello`/`world` back —
  1 test passed in ~5.6 s, containers and volumes removed afterwards. Containers
  created by that suite carry `capturehost.test=true`.
- Tests: policy 18, service 15 (fakes for Docker + pg), integration 1 (opt-in), plus
  19 new entries in the all-routes 401 loop.
- Two bugs the integration test caught that no mock would have: the missing
  capabilities (crash loop) and the `pg_dump` default unix socket (no `-h`).
- Gates: backend 447 tests / 25 files, launcher 21, `tsc` clean both packages, build
  122 modules, `npm audit` 0.

### 2026-11-09 — session 28 (clone + import a dump)
- `DatabaseService.cloneDatabase` (dump to memory → restore into a new database),
  `importDump` (file → new database), `importIntoExisting` (empty database only),
  `detectDumpFormat`, and `discard()` for a failed half-restore.
- Routes: `POST /api/databases/:id/clone`, `POST /api/databases/import?name=&version=`,
  `POST /api/databases/:id/import?confirm=`. The raw upload parser lives in
  `routes/databases.ts` (`registerUploadParser`) and is registered in `app.ts`.
  Config: `DATABASE_MAX_UPLOAD_BYTES`, `databases.importDir`.
- UI: the New database modal is three-way (**Empty / Clone existing / Upload a
  dump**) with a clone-source picker and a file input; the detail page gained an
  **Import a dump** card (name-typed, empty-database-only).
- Tests: `database-import.test.ts` (7 — format detection incl. tar and a refusal,
  clone, sql vs custom entrypoint, failed import leaves no row, empty file) and
  `database-import-routes.test.ts` (5 — CSRF on clone, 404, bad magic is a 400,
  a real SQL upload through Fastify with the temp file removed, confirm mismatch).
  The all-routes 401 loop gained the three new paths.
- **Real evidence again:** the opt-in integration suite now also clones a database
  and imports a decrypted snapshot into a third one, reading the row back each time —
  2 tests passed in 13.9 s against real `postgres:16-alpine`.
- Gates: 458 tests pass / 1 skipped, 28 files, `tsc` clean both, build 122 modules,
  audit 0.


### Session 26 — agent surface and deployment diagnoses

- `agent_tokens` / `agent_notes` tables (migration 011). Tokens are stored as
  SHA-256 hashes; the plaintext is returned once, in the creating response.
- `services/agentAccess.ts`: create / list / revoke / authenticate (timing-safe
  compare, revocation immediate, `last_used_at` stamped on every call).
- `routes/agent.ts`: token admin under `/api/agent/tokens` (session + CSRF) and the
  tool surface under `/api/agent/tools/*` (bearer token). Six verbs, 60 calls/min
  per token, every call audited as `agent.<tool>`. `/api/agent/tools/` is in
  `PUBLIC_PREFIXES` because it authenticates itself; `/api/agent/tokens` is not.
- `services/diagnosis.ts`: deterministic failure diagnoses (clone / dockerfile /
  build / start / health) attached to the deployment DTO, so the dashboard and the
  agent API tell the same story.
- Frontend: Settings → Agent access (create, show once, revoke), and the failure
  reason under the status pill in the deployments table.
- Deliberately **not** built: a host shell, filesystem access, Docker passthrough,
  or an LLM in the server. See `docs/AGENT-DESIGN.md` for the three architectures
  and why the sandboxed version is a separate project.
- Verified live: token issued → `whoami`, `list_projects`, `get_project`,
  `deploy_project` (queued #32) → deployment failed → diagnosis named the empty
  repository → token revoked → 401. Audit trail shows `agent.hermes-demo` rows and
  contains no token material.

### Session 27 — Dockerfiles for repositories that have none

- `services/dockerfileSuggestion.ts`: reads a clone's file names and manifests
  (package.json, requirements.txt, pyproject.toml, Procfile, go.mod, composer.json,
  Gemfile, Cargo.toml, index.html) and returns a Dockerfile for one of eight stacks,
  always bound to the project's container port, with `notes` saying what it guessed.
  Pure function over a fingerprint; no model, nothing from the repository is executed
  or interpreted as instructions.
- `services/dockerfileOverride.ts`: writes a stored Dockerfile into a clone — only
  when the repository has nothing at that path (`repo-wins`), never outside the clone
  (`unsafe-path` for `../` or absolute paths).
- Migration 012: `dockerfile_override`, `dockerfile_override_source`,
  `dockerfile_override_at` on `projects`; `db/dockerfile.repo.ts` for get/set/clear.
- Routes: `POST /api/projects/:id/dockerfile/suggest` (clones, 10/min),
  `GET|PUT|DELETE /api/projects/:id/dockerfile`, all audited. Agent tools
  `suggest_dockerfile` (read tokens) and `set_project_dockerfile` (deploy tokens).
- Frontend: `DockerfileCard` on the project Overview — suggest, edit, save, remove.
- Pipeline logs which of the three happened: generated file used, repository file
  used, or the stored path refused as unsafe.
- Found and fixed while testing live: a trailing comment on `USER root` is parsed as
  part of the account name and the container refuses to start; `USER` now gets its
  own line. Added the `start-refused` diagnosis rule for exactly that failure.
- Verified live on project 7 (`animeflv-api-backend`, Flask + gunicorn): suggested
  python:flask, saved, deployed → deployment #38 live, container
  `capturehost-animeflv-api-backend-38` on 127.0.0.1:8100, `GET /health` → 200.
  Suite 499 passed / 2 skipped; build 126 modules.

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
