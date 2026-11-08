# CaptureHost

Self-hosted hosting dashboard for a single Arch Linux machine: live system
metrics, Docker control, GitHub deployments and subdomains with automatic
HTTPS — one web UI, no cloud account.

**Status: Phase 2 (authentication) complete.** Later phases are listed in
[PROGRESS.md](./PROGRESS.md), which is the authoritative project state.

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 20+, TypeScript, Fastify 5, `@fastify/websocket`, zod |
| Data | SQLite (`better-sqlite3`, WAL) with numbered migrations |
| Frontend | React 19, Vite, TypeScript, plain CSS (dark theme) |
| Metrics | `systeminformation` + `nvidia-smi` (GPU, optional) |
| Proxy (later) | Caddy, driven through its admin API |

## Requirements (Arch Linux)

```bash
sudo pacman -S --needed nodejs npm git sqlite docker
sudo systemctl enable --now docker
# optional, only if you want GPU metrics:
sudo pacman -S --needed nvidia-utils
```

Docker needs your user in the `docker` group for Phase 3:

```bash
sudo usermod -aG docker "$USER"   # log out and back in afterwards
```

## Run it (development)

Two processes: the API on `127.0.0.1:8787` and the Vite dev server on
`127.0.0.1:5173` (which proxies `/api` and `/ws` to the backend, so the browser
only ever sees one origin).

```bash
git clone <your-repo> capturehost && cd capturehost

# backend
cd backend
cp .env.example .env
openssl rand -base64 32        # paste the result into APP_ENCRYPTION_KEY
npm install
npm run setup:admin            # prompts for username + password (hidden input)
npm run dev                    # http://127.0.0.1:8787/api/health

# frontend (second terminal)
cd frontend
npm install
npm run dev                    # http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173> and sign in with the account you just created.

There is no public signup and no HTTP endpoint that creates an account: the
first admin can only be created from a shell on the machine. If you lose the
password, `npm run reset:admin` (also shell-only) wipes the account so
`setup:admin` can run again.

## Verify

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s "http://127.0.0.1:8787/api/metrics/history?range=1h" | head -c 300

cd backend  && npx vitest run          # 77 tests
cd frontend && npm run typecheck && npm run build
```

## Build for production

```bash
cd backend  && npm run build && npm start     # dist/index.js, still 127.0.0.1
cd frontend && npm run build                  # static files in dist/
```

## Security model (short version)

- The backend binds **127.0.0.1 only**. Expose it with Tailscale or a
  Cloudflare Tunnel — never open a public port.
- **Everything under `/api` requires a session** except `GET /api/health`, the
  login endpoints and `setup-status`. New routes are protected by default.
- Passwords are argon2id (64 MB, t=3). Unknown usernames still run a dummy
  verify, so response timing does not reveal whether an account exists.
- Sessions are a 256-bit token in an httpOnly, SameSite=Strict cookie; only its
  SHA-256 is stored. Idle 30 min, absolute 12 h, rotated on every login and
  again after 2FA. Logging out (or revoking a session) closes its WebSockets.
- Writes need a session-bound CSRF token in `x-csrf-token`; the `Origin` header
  is checked against `ALLOWED_ORIGINS` on every unsafe method.
- Login throttling is per IP **and** per username, stored in SQLite so a restart
  cannot clear a lockout. Lockouts answer 429 + `Retry-After` and never say
  which limit was hit.
- Optional TOTP 2FA: secrets encrypted at rest with AES-256-GCM
  (`APP_ENCRYPTION_KEY`), codes accepted once per 30 s window, plus 8 one-time
  recovery codes stored as hashes.
- `/ws/metrics` checks the `Origin` header **and** the session cookie, because
  browsers do not apply the same-origin policy to WebSockets.
- Every query parameter is validated with zod; history has a fixed bucket
  allowlist and a hard 720-row cap.
- No shell string building anywhere: external binaries are called with
  `execFile` and argument arrays.
- Secrets live in `.env` (gitignored); `.env.example` documents every key.
- Errors are generic to the client, detailed to the server log.
- Every login, failure, lockout, logout, 2FA change, password change and session
  revocation is written to `audit_log` (never with secrets in `detail`).

## Layout

```
capturehost/
  backend/           Fastify API, SQLite, metrics sampler
    src/db/migrations/   numbered SQL, applied once
    tests/               vitest: migrations, metrics, gpu, api + ws
  frontend/          React dashboard
    src/components/      one CSS file per component
    src/pages/           Dashboard (live) + phase scaffolds
  PROGRESS.md        phase state, decisions, how to resume
```
