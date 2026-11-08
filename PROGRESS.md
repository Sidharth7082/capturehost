# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update it at the end of every work session. Never leave it stale.

Last updated: 2026-11-08 (session 2 — Phase 1 complete)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 1 — Monitoring: DONE**, awaiting "next" for Phase 2 |
| Verified state | 30/30 backend tests pass, `tsc` clean both packages, `npm audit` 0 vulns, dashboard screenshotted at 1440 and 390 |
| Last commit | `chore: scaffold monorepo and project state tracking` (393cd4c) |
| Next action | Phase 2 — authentication (argon2, sessions, CSRF, rate limit, TOTP, audit log) |

---

## 2. Phase checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done + verified by running it

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, git, tracking docs | `[x]` |
| 1 | Monitoring: `/api/health`, `ws /ws/metrics`, SQLite 24 h history, dashboard | `[x]` |
| 2 | Auth: argon2, sessions, CSRF, rate limit, TOTP, audit log | `[ ]` next |
| 3 | Docker: socket proxy, container control, live logs | `[ ]` |
| 4 | GitHub deploy: clone, build, webhook HMAC, rollback | `[ ]` |
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
| Node | v26.13.0 (`/usr/bin/node`) |
| npm | 12.2.1 |
| Docker | daemon 29.9.2 running, client `~/.local/bin/docker` |
| GPU | RTX 3050 Laptop, 4096 MiB — `nvidia-smi` works, GPU metrics live (seen at 40 %) |
| Caddy | **NOT installed** — `pacman -S caddy` in Phase 5 |
| SQLite CLI | `/usr/bin/sqlite3` |
| Repo | `/home/capture/capturehost` |
| git identity | Sidharth7082 / sidharthkaushal558@gmail.com |

---

## 4. Running it (dev)

```bash
# terminal 1
cd ~/capturehost/backend && cp .env.example .env && npm run dev     # :8787

# terminal 2
cd ~/capturehost/frontend && npm run dev                            # :5173, proxies /api + /ws
```

---

## 5. What Phase 1 actually shipped

Backend (`backend/src`):
- `config.ts` — zod-validated env, fails fast, normalises origins
- `server.ts` — `createServer(logger)` + exported `AppInstance` type
- `app.ts` — `buildApp()` wires plugins, sampler, routes, hooks (never listens)
- `index.ts` — config → log → db → migrate → listen on 127.0.0.1 only
- `db/connection.ts` — WAL, foreign_keys ON, busy_timeout, synchronous NORMAL
- `db/migrate.ts` + `db/migrations/001_core.sql` — all 8 tables, append-only runner
- `db/metrics.repo.ts` — insert / bucketed history / prune / count
- `services/gpu.ts` — `execFile('nvidia-smi', [...])`, graceful null + 60 s backoff
- `services/metrics.ts` — `collectSnapshot()` + `MetricsSampler` (single global, non-overlapping)
- `routes/health.ts`, `routes/metrics.ts` — health, history, WS + hub fan-out
- `middleware/errorHandler.ts` — generic to client, detail to log
- `utils/errors.ts` (`AppError`), `utils/origin.ts` (`isOriginAllowed`)
- `tests/` — migrations, metrics repo, gpu (incl. **missing nvidia-smi**), api + WS origin

Frontend (`frontend/src`):
- `styles/tokens.css`, `base.css`, `layout.css`
- `api/client.ts` (typed fetch + `ApiError`)
- `hooks/` — `useMetricsSocket`, `useHistory`, `useLocalStorage`, `useMediaQuery`, `MetricsProvider`
- `components/` — `Layout`, `CommandPalette`, `Icon`, `Button`, `Card`, `StatCard`,
  `StatusPill`, `DataTable`, `Modal`, `Toast`, `EmptyState`, `Skeleton`, `Tabs`,
  `Dropdown`, `Sparkline`, `LineChart`, `ConnectionBadge`
- `pages/` — `Dashboard` (live) + `Projects`, `Containers`, `Deployments`, `Domains`,
  `Databases`, `Logs`, `Settings` (real scaffold: toolbar, table, empty state)
- `navigation.ts` — one source for sidebar, topbar titles and the palette

---

## 6. Route inventory (actual)

### Built in Phase 1
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | status, version, uptime, db |
| GET | `/api/metrics/history` | open* | zod: `range` 1h\|6h\|24h, `bucket` ∈ {30,60,300,900,1800,3600}, hard cap 720 rows (newest kept) |
| WS | `/ws/metrics` | open* + Origin allowlist | `hello` then a `snapshot` every 2 s |

\* Auth arrives in Phase 2. Until then the server binds `127.0.0.1` only.

### Reserved
| Phase | Routes |
|---|---|
| 2 | `POST /api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/totp/{setup,verify,disable}` |
| 3 | `GET /api/containers`, `GET /api/containers/:id`, `POST /api/containers/:id/{start,stop,restart}`, `DELETE /api/containers/:id`, `WS /ws/containers/:id/logs` |
| 4 | `POST/GET /api/projects`, `DELETE /api/projects/:id`, `POST /api/projects/:id/deploy`, `GET /api/deployments/:id`, `WS /ws/deployments/:id`, `POST /api/webhooks/github/:projectId`, `POST /api/deployments/:id/rollback` |
| 5 | `GET/POST /api/domains`, `DELETE /api/domains/:id`, `POST /api/domains/:id/verify` |
| 6 | `GET/PUT /api/settings`, `POST /api/settings/backup`, `GET /api/audit` |

---

## 7. Decisions locked in Phase 1

1. `createServer()` in `server.ts` returns an instance typed with our pino
   `Logger`; `AppInstance` is that type. Fixes Fastify's logger-generic mismatch
   when the app is passed into route registrars.
2. Baseline schema (all 8 tables) lives in `001_core.sql`; later phases only add
   `002_*`, `003_*`.
3. WS Origin allowlist: **a missing Origin is rejected too** (browsers always
   send one). Configurable with `ALLOWED_ORIGINS`.
4. One global sampler fans out to all sockets; the frontend holds exactly one
   socket via `MetricsProvider` (verified: 2 sparklines, 1 connection).
5. History bucketing: `CAST(ts / bucketMs AS INTEGER) * bucketMs`; inner query
   takes the newest buckets (`ORDER BY … DESC LIMIT n`), outer re-sorts ascending.
6. GPU absent ⇒ `null`, never `0`; `parseNvidiaSmiLine` treats `[N/A]` as null.
7. Frontend: plain CSS + custom properties, hand-rolled SVG charts, Inter bundled
   from `@fontsource-variable/inter` (no CDN), icons inline SVG.
8. Dev proxy in `vite.config.ts` ⇒ one origin, so no CORS and cookies stay
   same-origin for Phase 2.
9. `trustProxy: false` until Caddy exists (Phase 5 revisits it).

---

## 8. Known gaps / deliberate deferrals

- `docker-compose.yml` not written yet — Phase 3 needs the socket proxy anyway.
- `README.md` is intentionally short; the full setup + troubleshooting doc is Phase 6.
- `admin`, `sessions`, `projects`, `deployments`, `domains`, `env_vars`,
  `audit_log` tables exist and are tested but unused until their phase.
- No auth on `/api/metrics/history` or `/ws/metrics` yet — loopback + Origin
  check only. Phase 2 closes this.
- Dark theme only (per brief); light theme toggle deferred.
- Disk stat card has no sparkline (no live disk buffer yet).
- Nav items for future pages are disabled with a "Soon" tag — do not remove them,
  enable them as their phase lands.

---

## 9. Session log (append-only, newest last)

### 2026-11-08 — session 1
- Verified machine facts; created repo skeleton, `.gitignore`, this file, git init.

### 2026-11-08 — session 2
- Backend built end to end (config, db + migrations, sampler, GPU probe, health +
  history + WS routes, error handler) with 30 tests.
- Frontend built to the design brief: tokens/base/layout CSS, 17 components,
  8 pages, dark theme, responsive, a11y.
- Verified: health `{"status":"ok","version":"0.1.0","db":"ok"}`; WS frame carries
  real CPU/mem/disk/net plus `gpuUtilPct:40, gpuTempC:41`; foreign *and* missing
  Origin → close 1008; `range=90d` → 400; `bucket=7` → 400; 24h@30s →
  `truncated:true`; 1440 and 390 widths both have zero horizontal scroll.
- `npm audit`: 0 vulnerabilities (backend, frontend).
- Two bugs caught by looking at the rendered page, not by tests: disabled nav
  labels were centre-aligned (`<button>` default `text-align:center` in a flex
  row) and sparklines auto-scaled instead of using a fixed 0–100 domain.

---

## 10. How to resume (for the next agent)

1. Read this file completely.
2. `cd ~/capturehost && git log --oneline -5 && git status --short`.
3. `cd backend && npx vitest run` — must be green before changing anything.
4. Never restart a phase marked `[x]`; never start Phase N+1 before the user says
   "next" for Phase N.
5. Update §1, §2, §7, §9 here at the end of every session, then commit.
