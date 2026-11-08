# CaptureHost — Project State

> **THIS FILE IS THE SINGLE SOURCE OF TRUTH.**
> Any AI agent or human resuming work: read this file top to bottom BEFORE
> touching code. Update it at the end of every work session. Never leave it stale.

Last updated: 2026-11-08 (session 3 — Phase 2 complete)

---

## 1. Where we are

| Item | Value |
|---|---|
| Current phase | **Phase 2 — Authentication: DONE**, awaiting "next" for Phase 3 |
| Verified state | 77 backend tests pass, `tsc` clean both packages, `npm audit` 0 vulns, every route exercised with real curl + a real browser |
| Last commit | `feat(phase-1): live monitoring dashboard` (2790abd) |
| Next action | Phase 3 — Docker management behind a socket proxy |

---

## 2. Phase checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done + verified by running it

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold, git, tracking docs | `[x]` |
| 1 | Monitoring: `/api/health`, `ws /ws/metrics`, SQLite 24 h history, dashboard | `[x]` |
| 2 | Auth: argon2, sessions, CSRF, rate limit, TOTP, audit log | `[x]` |
| 3 | Docker: socket proxy, container control, live logs | `[ ]` next |
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
| Node | v26.13.0 (`/usr/bin/node`) — `.env` loaded via `process.loadEnvFile` |
| npm | 12.2.1 |
| Docker | daemon 29.9.2 running, client `~/.local/bin/docker` |
| GPU | RTX 3050 Laptop, 4096 MiB — `nvidia-smi` works |
| Caddy | **NOT installed** — `pacman -S caddy` in Phase 5 |
| SQLite CLI | `/usr/bin/sqlite3` |
| Repo | `/home/capture/capturehost` |
| git identity | Sidharth7082 / sidharthkaushal558@gmail.com |
| Local dev admin | username `sid`, password set through `setup:admin`, **2FA off** |

---

## 4. Running it (dev)

```bash
# first time only
cd ~/capturehost/backend && cp .env.example .env
openssl rand -base64 32        # paste into APP_ENCRYPTION_KEY
npm run setup:admin            # interactive; creates the only admin account

# every time
cd ~/capturehost/backend  && npm run dev     # :8787, loopback only
cd ~/capturehost/frontend && npm run dev     # :5173, proxies /api + /ws
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
- `config.ts` additions — `APP_ENCRYPTION_KEY` (32-byte, b64/hex), session
  idle/absolute, `__Host-` cookie name when `SESSION_COOKIE_SECURE`, argon2 cost,
  lockout window, `TRUST_PROXY`
- `crypto/password.ts` — argon2id, **dummy verify** for unknown users, strength policy
- `crypto/token.ts` — 256-bit session/CSRF tokens, SHA-256 token hashing
- `crypto/secretbox.ts` — AES-256-GCM, AAD context, `v1.iv.tag.ct`
- `crypto/totp.ts` — otplib v13, QR data URL, ±30 s tolerance, `afterTimeStep` replay guard
- `db/migrations/002_auth.sql` — ALTER only: `absolute_expires_at`, `kind`,
  `totp_last_step`, `last_password_change`, `recovery_codes`, `login_attempts`
- `db/auth.repo.ts`, `db/audit.repo.ts`
- `services/auth.ts` (login, 2FA, sessions, password), `services/socketRegistry.ts`
- `middleware/auth.ts` — global guard: Origin → session → public? → pending-2FA → CSRF
- `routes/auth.ts`, `routes/audit.ts`
- `scripts/setup-admin.ts` (+ `CH_SETUP_USERNAME`/`CH_SETUP_PASSWORD` for automation),
  `scripts/reset-admin.ts`, `utils/env.ts`
- Frontend: `auth/AuthContext.tsx`, `auth/RequireAuth.tsx`, `pages/Login.tsx`,
  `pages/Settings.tsx` + `settings/{Password,TwoFactor,Sessions,Audit}Section.tsx`,
  real `pages/Logs.tsx`, username badge + sign-out in `Layout.tsx`

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

Reserved: Phase 3 containers (+ WS log tail), Phase 4 projects/deployments/webhook,
Phase 5 domains, Phase 6 settings/backup.

---

## 7. Decisions locked

### Phase 1
1. `createServer()` in `server.ts` returns an instance typed with our pino
   `Logger`; `AppInstance` is that type (fixes Fastify's logger-generic mismatch).
2. Baseline schema (all 8 tables) lives in `001_core.sql`; later phases only add
   `002_*`, `003_*`.
3. WS Origin allowlist: **a missing Origin is rejected too**.
4. One global sampler fans out to all sockets; the frontend holds exactly one
   socket via `MetricsProvider`.
5. History bucketing in SQL; inner query takes the newest buckets, outer re-sorts.
6. GPU absent ⇒ `null`, never `0`.
7. Plain CSS + custom properties, hand-rolled SVG charts, Inter bundled locally.
8. Dev proxy in `vite.config.ts` ⇒ one origin, no CORS needed.
9. `trustProxy` off until a real proxy exists (Phase 5 revisits).

### Phase 2
10. **Two 401 codes.** `unauthenticated` = no valid session (client logs out).
    Any other 401 (`unauthorized`) means the action failed — wrong password, bad
    TOTP — so a typo never ejects the user from the app.
11. **Pending-2FA sessions are not sessions.** 5 minute life, refused everywhere
    except `login/2fa` and `logout`, destroyed on rotation.
12. **Token rotation twice**: new token for the pending state, new token again
    after the 2FA step.
13. **Rate-limit state in SQLite**, not memory: a restart must not clear a lockout.
    Keyed by `('ip'|'username', value)`, window resets when the oldest failure is
    stale, lockout doubles up to 8×.
14. **Identical work for unknown users** (`runDummyVerify`), so timing does not
    reveal whether the account exists.
15. **CSRF is session-bound**, sent as `x-csrf-token`, compared with
    `timingSafeEqual`; Origin is checked on every unsafe method when present.
16. **TOTP ±1 window tolerance, replay blocked by `afterTimeStep`** against the
    stored `totp_last_step`.
17. **Recovery codes**: 8 per enable, shown once, stored as SHA-256, consumed via
    `UPDATE ... WHERE used_at IS NULL` so concurrent requests cannot both win.
18. Guard order is Origin → session → public test → pending-2FA → CSRF.

---

## 8. Known gaps / deliberate deferrals

- `docker-compose.yml` — Phase 3 (needs the socket proxy).
- Full README with troubleshooting — Phase 6.
- Light theme toggle — not requested yet. Disk stat card has no sparkline.
- No "forgot password" by design: recovery is `npm run reset:admin` from a shell.
- `projects`, `deployments`, `domains`, `env_vars` tables still unused.
- Audit log has no retention/rotation yet (Phase 6).
- Pending (unconfirmed) TOTP secrets can linger in `admin.totp_secret` until the
  next setup overwrites them; `totp_enabled` stays 0 so they are inert.

---

## 9. Session log (append-only, newest last)

### 2026-11-08 — session 1
- Verified machine facts; created repo skeleton, `.gitignore`, this file, git init.

### 2026-11-08 — session 2
- Phase 1 built end to end (30 tests): config, db + migrations, sampler, GPU
  probe, health + history + WS routes, error handler; frontend design system and
  live dashboard.
- Verified: health ok; WS frame with real CPU/mem/disk/net + GPU; foreign *and*
  missing Origin → close 1008; `range=90d` → 400; `bucket=7` → 400; 24h@30s →
  `truncated:true`; no horizontal scroll at 1440 or 390.
- Two bugs caught by looking at the render: `<button>` text-align centring nav
  labels, and sparklines auto-scaling instead of a 0–100 domain.

### 2026-11-08 — session 3
- Phase 2 shipped (77 tests): argon2id + dummy verify, sessions with rotation,
  CSRF, Origin checks, SQLite lockout, TOTP with replay guard + recovery codes,
  audit log + paginated API, socket registry closing sockets on logout.
- Frontend: auth context, login with 2FA step, protected routes, settings
  (password / 2FA / sessions / recent audit), real username in the sidebar.
- Verified live with curl: health 200 without auth · history 401 without session ·
  login 200 → history 200 · wrong password 401 generic · write without CSRF 403.
- Verified in the browser: login → dashboard · Settings shows 2 sessions with
  "this device" · enabled 2FA (QR → 8 recovery codes) → disabled again with
  password + a fresh code · sign-out returns to /login with a toast.
- Bugs found by using the app, not by tests:
  - a failed 2FA code logged the whole session out (any 401 triggered logout);
    fixed with the `unauthenticated` code and only reacting to that;
  - TOTP had zero tolerance, so a code typed 40 s after generation was rejected;
  - nothing loaded `.env` at all — config only ever saw `process.env`;
  - the recovery-codes screen rendered on top of the disable form.
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
   should be verified as closed.
6. Update §1, §2, §7, §9 here at the end of every session, then commit.
