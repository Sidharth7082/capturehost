# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update the checkbox tables and "Next action" at the end of
> every work session. Never leave it stale.

Last updated: 2026-11-08 (session 1)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 1 — Monitoring** |
| Phase 1 code written? | **No** — folder skeleton + tracking docs only |
| Blocked on | User approval of folder structure + route list |
| Last completed step | Repo scaffolded, git initialised, plan presented |
| Next action | On approval: write all Phase 1 backend + frontend files, run, verify |

---

## 2. Phase checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done + verified

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, git, tracking docs | `[x]` |
| 1 | Monitoring (`/api/health`, `ws /ws/metrics`, SQLite history, dashboard) | `[~]` planning approved? no |
| 2 | Auth (argon2, sessions, CSRF, rate limit, TOTP, audit log) | `[ ]` |
| 3 | Docker (socket proxy, container control, live logs) | `[ ]` |
| 4 | GitHub deploy (clone, build, run, webhook HMAC, rollback) | `[ ]` |
| 5 | Domains + Caddy admin API + HTTPS | `[ ]` |
| 6 | Polish (backups, settings, notifications, README) | `[ ]` |

---

## 3. Machine / environment facts (verified, not assumed)

| Fact | Value |
|---|---|
| OS | Arch Linux, kernel 7.2.11-arch1-1 |
| CPU | 12 threads |
| RAM | 31 GiB total (~6.3 GiB used at scaffold time) |
| Disk | / on nvme0n1p3, 433G total, 97G free (77% used) |
| Node | v26.13.0 — `/usr/bin/node` |
| npm | 12.2.1 |
| Docker | daemon 29.9.2 running, client at `~/.local/bin/docker` |
| GPU | NVIDIA GeForce RTX 3050 Laptop GPU, 4096 MiB — `nvidia-smi` present → GPU metrics WILL work |
| Caddy | **NOT installed** — needed in Phase 5 (`pacman -S caddy`) |
| SQLite CLI | present (`/usr/bin/sqlite3`) |
| Obsidian vault | `/home/capture/Documents/Obsidian Vault` |
| Repo path | `/home/capture/capturehost` |
| git identity | Sidharth7082 / sidharthkaushal558@gmail.com |

---

## 4. Locked decisions (do not change without asking the user)

1. Monorepo: `backend/` (Fastify + TS) and `frontend/` (React + Vite + TS).
2. SQLite via `better-sqlite3` (synchronous, WAL mode, prepared statements).
3. `app.ts` builds the Fastify instance, `index.ts` only listens → tests run
   without binding ports.
4. One global metrics sampler broadcasts to all WS clients — N clients must
   never cause N `systeminformation` calls.
5. History chart is hand-rolled SVG — no chart library (bundle size, zero deps).
6. Migrations are numbered SQL files applied by a tiny runner that tracks
   `schema_migrations` — no ORM, no ad-hoc SQL.
7. Backend binds `127.0.0.1` only, always. Remote access = Tailscale/Cloudflare
   Tunnel, never an open port.
8. No shell string building, ever: `execFile` with argument arrays.
9. Caddy is not installed yet; Phase 5 installs it. Phase 1 ships a stub config
   hint only.
10. Auth is added in Phase 2, so Phase 1 routes are open **on localhost only** —
    flagged, not forgotten.

---

## 5. Database schema (target, per user spec)

Tables: `admin`, `sessions`, `projects`, `deployments`, `domains`,
`env_vars` (values encrypted), `metrics` (24 h history), `audit_log`.

Plan: `001_core.sql` creates the full baseline schema in Phase 1 (schema is
fully specified up front), later phases add `002_*.sql`, `003_*.sql` for
changes only. Pending user approval.

---

## 6. Route inventory

### Phase 1 (to build now)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | liveness: status, uptime, version, db check |
| GET | `/api/metrics/history` | public (P1) | bucketed history for the chart |
| WS | `/ws/metrics` | public (P1) | live snapshot every 2 s |

### Reserved for later phases
| Phase | Routes |
|---|---|
| 2 | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/setup`, `POST /api/auth/totp/*` |
| 3 | `GET /api/containers`, `GET /api/containers/:id`, `POST /api/containers/:id/{start,stop,restart}`, `DELETE /api/containers/:id`, `WS /ws/containers/:id/logs` |
| 4 | `POST /api/projects`, `GET /api/projects`, `DELETE /api/projects/:id`, `POST /api/projects/:id/deploy`, `GET /api/deployments/:id`, `WS /ws/deployments/:id`, `POST /api/webhooks/github/:projectId`, `POST /api/deployments/:id/rollback` |
| 5 | `GET /api/domains`, `POST /api/domains`, `DELETE /api/domains/:id`, `POST /api/domains/:id/verify` |
| 6 | `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/backup`, `GET /api/audit` |

---

## 7. Open questions for the user

- [ ] Approve Phase 1 folder structure + route list → then code gets written.
- [ ] OK to create the full baseline schema in `001_core.sql` (all 7 tables) vs.
      one migration per phase? Default: full baseline in 001.
- [ ] Tailwind or plain CSS? Spec allows either. Default: **plain CSS with
      custom properties** (dark theme, no build step, fewer deps).

---

## 8. Session log (append-only, newest last)

### 2026-11-08 — session 1
- Verified machine facts (Node v26.13.0, Docker 29.9.2, RTX 3050, Caddy absent).
- Created repo skeleton at `/home/capture/capturehost`, `git init`.
- Created `.gitignore`, `PROGRESS.md` (this file), Obsidian tracker notes.
- Presented Phase 1 structure + routes; **awaiting approval before writing code**.

---

## 9. How to resume (for the next agent)

1. Read this entire file.
2. `cd /home/capture/capturehost && git log --oneline -5` to see the last commit.
3. Check the checklist in §2 — never restart a phase marked `[x]`.
4. Ask the user "next?" only when the current phase is `[x]`.
5. After finishing work: update §1, §2, §8, and the mirror note in Obsidian
   (`CaptureHost — Project Tracker`), then commit with the suggested message.
