# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update it at the end of every work session. Never leave it stale.

Last updated: 2026-11-08 (session 4 — Phase 3 complete)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 3 — Docker management: DONE**, awaiting "next" for Phase 4 |
| Verified state | 121 backend tests pass, `tsc` clean both packages, `npm audit` 0 vulns, live integration script green against the real daemon, screenshots at 1440 and 390 |
| Last commit | `feat(phase-2): authentication, sessions, CSRF and TOTP` (0429068) |
| Next action | Phase 4 — GitHub deployment (clone, build, webhook HMAC, rollback) |

---

## 2. Phase checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done + verified by running it

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, git, tracking docs | `[x]` |
| 1 | Monitoring: `/api/health`, `ws /ws/metrics`, SQLite 24 h history, dashboard | `[x]` |
| 2 | Auth: argon2, sessions, CSRF, rate limit, TOTP, audit log | `[x]` |
| 3 | Docker: socket proxy, container control, live logs | `[x]` |
| 4 | GitHub deploy: clone, build, webhook HMAC, rollback | `[ ]` next |
| 5 | Domains + Caddy admin API + HTTPS | `[ ]` |
| 6 | Polish: backups, settings, notifications, README | `[ ]` |

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

Reserved: Phase 4 projects/deployments/webhook, Phase 5 domains, Phase 6 settings/backup.
There is deliberately **no exec endpoint and no create-container endpoint**.

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

---

## 8. Known gaps / deliberate deferrals

- `docker-compose.yml` for production — Phase 6 (dev compose exists).
- Full README with troubleshooting — Phase 6.
- Light theme toggle — not requested yet. Disk stat card has no sparkline.
- No "forgot password" by design: recovery is `npm run reset:admin` from a shell.
- `projects`, `deployments`, `domains`, `env_vars` tables still unused.
- Audit log has no retention/rotation yet (Phase 6).
- No container **create** or **exec** from the UI — deliberate (Phase 4 creates
  containers through its own deploy path).
- Inspect shows env **names only**; editing env vars is Phase 4/6.
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

---

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
