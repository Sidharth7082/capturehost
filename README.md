# CaptureHost

A self-hosted hosting dashboard for one laptop: watch the machine, control
Docker, deploy a GitHub repo behind a hostname, back it all up — from a single
private web UI, with no cloud account.

It is **inspired by Coolify and CapRover** and deliberately smaller: one machine,
one admin, no clustering. It was built as a learning project (BCA), which is why
it spends its effort on the parts those tools hide — a container policy you can
read and attack, signature-checked webhooks, blue/green swaps, Caddy routes
reconciled from SQLite, encrypted backups, and a security doctor you can run from
a shell.

Known limits, stated up front: **single machine only**; deployments need a
**Dockerfile** (no buildpack detection); `public` Caddy mode is **untested**; and
deploy **only repositories you trust** — a build runs that repo's code here.

**Status: all six phases complete** (monitoring, auth, Docker, deployments,
domains/Caddy, backups + hardening). [PROGRESS.md](./PROGRESS.md) is the
authoritative project state; [deploy/README.md](./deploy/README.md) is the
production setup and [deploy/DESIGN-NOTE.md](./deploy/DESIGN-NOTE.md) explains
why the backend runs as a systemd service rather than in a container.

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 20+, TypeScript, Fastify 5, `@fastify/websocket`, zod |
| Data | SQLite (`better-sqlite3`, WAL) with numbered migrations |
| Frontend | React 19, Vite, TypeScript, plain CSS (dark theme) |
| Metrics | `systeminformation` + `nvidia-smi` (GPU, optional) |
| Proxy | Caddy, driven through its admin API (routes tagged `capturehost-<id>`) |
| Ops | encrypted backups, notification feed, retention jobs, security doctor |

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
only ever sees one origin). The steps below are the one-time setup; after that,
`python3 capturehost.py` starts the whole stack (see the next section).

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

## Run everything with one command

Once the one-time setup above is done (`.env` with a key, `npm install`, an admin
account), the four processes — socket proxy, Caddy, backend, frontend — start in
dependency order from the repo root:

```bash
python3 capturehost.py            # foreground: prefixed, colour-coded logs, Ctrl-C stops it all
python3 capturehost.py start -d   # background; returns when everything is healthy
python3 capturehost.py status     # service, state, pid, port, health
python3 capturehost.py logs backend -f
python3 capturehost.py stop       # only what this script started
```

Optional alias:

```bash
alias capturehost='python ~/capturehost/capturehost.py'
```

What it guarantees, because a launcher that gets these wrong is worse than no
launcher:

- **It only stops what it started.** Pids go to `.run/pids.json` and are re-verified
  (pid, process group, cwd, command line) before any signal, then the whole process
  group gets SIGTERM, 10 s, SIGKILL — so `npm`'s `tsx`/`vite` children go with it.
  Containers started by a deployment are never touched; the socket proxy is stopped
  with `docker compose stop` for this repo's compose file only.
- **Idempotent.** Starting twice reports "already running" instead of duplicating.
- **Loud about port conflicts.** If something else holds a port it prints the owner
  from `ss` and exits non-zero, rolling back what it already started. It never kills
  a process it did not start.
- **No sudo, no shell.** Argument lists with explicit cwds; Docker is checked, not
  started (`sudo systemctl start docker` is your call).
- `--no-frontend` (backend + Caddy only) and `--prod` (a pointer to the systemd
  setup — production is *not* this script).

Logs live in `.run/logs/<service>.log`, rotated at 5 MB (`.run/` is git-ignored).
Unit tests for the helpers: `python3 -m unittest discover -s tests -v`.

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

## Docker access (privileged, proxied)

The dashboard can start, stop, restart and remove containers — so it must not
hold the Docker socket. Only a proxy container does, mounted read-only:

```bash
docker compose -f docker-compose.dev.yml up -d     # socket proxy on 127.0.0.1:2375
```

`tecnativa/docker-socket-proxy` is pinned and exposes exactly what the UI needs
(`CONTAINERS`, `IMAGES`, `INFO`, `EVENTS`, `PING`, `POST`, `BUILD`). Everything else
— `EXEC`, `VOLUMES`, `NETWORKS`, `SECRETS`, `SYSTEM`, `SWARM`, `PLUGINS`, `SESSION`,
`GRPC` — stays at 0, so a compromise of the dashboard cannot exec into a container
or prune the host. `BUILD` is only needed for Phase 4's `POST /build`; BuildKit
(`SESSION`/`GRPC`) stays off, so the classic builder is the only path.

Because the proxy filters **URLs and methods, not request bodies**, the backend
enforces container safety itself (`backend/src/services/containerPolicy.ts`).

Three things are enforced in the backend, not just hidden in the UI:

- the proxy container (labelled `capturehost.protected=true`) and anything in
  `DOCKER_PROTECTED_CONTAINERS` cannot be stopped, restarted or removed (403,
  audited);
- a running container cannot be removed (409) — stop it first;
- `container inspect` returns environment **key names**, never values.

To verify the backend has no socket access:

```bash
PID=$(pgrep -f "index[.]ts"); ls -l /proc/$PID/fd | grep -c docker.sock   # -> 0
docker inspect capturehost-socket-proxy --format '{{range .Mounts}}{{.Source}} rw={{.RW}}{{end}}'   # -> rw=false
```

Live end-to-end check (creates and removes only its own labelled container):

```bash
DOCKER_API_PASSWORD='…' node scripts/integration-docker.mjs
```

## Deploy a site from GitHub

A project = one repository, one branch, one Dockerfile, one container.

1. **Projects → New Project**: name, `https://github.com/owner/repo`, branch,
   Dockerfile path (`Dockerfile` by default) and the port the container listens on.
   A GitHub token is optional and only needed for private repositories — it is
   encrypted with `APP_ENCRYPTION_KEY` and never shown again.
2. Press **Deploy**. The pipeline clones (shallow, single branch), builds the
   Dockerfile, starts the container, health-checks it, and only then stops the
   previous one (blue/green).
3. Open `http://127.0.0.1:<host port>` — the port is shown on the project page.
   Every deploy takes a fresh port from `CONTAINER_PORT_RANGE_*`; Phase 5 puts
   Caddy in front so the hostname stops changing.

What the container gets, always (see `containerPolicy.ts`, tests included):

| Setting | Value |
|---|---|
| privileged / host network / host pid / host ipc | never |
| bind mounts, devices, docker socket | never |
| capabilities | `drop: ALL`, add back only `NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID` |
| security options | `no-new-privileges` |
| memory / swap | project limit, hard-capped by `CONTAINER_MEMORY_MB_MAX` |
| CPU / pids | project limit, hard-capped |
| published port | `127.0.0.1` only, inside the configured range |
| restart policy | `unless-stopped` |
| labels | `capturehost.managed=true`, `capturehost.project=<id>` |

**Webhook auto-deploy.** Each project has a secret shown in *Settings → Webhook*.
GitHub signs the body with HMAC-SHA256 (`X-Hub-Signature-256`); the backend verifies
it over the raw bytes before parsing JSON, only accepts `push` to the project's
branch, and deduplicates by `X-GitHub-Delivery`. Since the backend listens on
127.0.0.1, expose **only** `/api/webhooks/github/<id>` through a tunnel before
adding the webhook in the repository settings.

```bash
# manual webhook smoke test (no tunnel needed, talks to loopback directly)
BODY='{"ref":"refs/heads/main","after":"<sha>"}'
SECRET='<from Settings → Webhook>'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
curl -i -X POST http://127.0.0.1:8787/api/webhooks/github/1 \
  -H 'content-type: application/json' -H 'x-github-event: push' \
  -H "x-github-delivery: manual-$RANDOM" -H "x-hub-signature-256: sha256=$SIG" \
  --data-raw "$BODY"

# full end-to-end check: create → deploy → redeploy → rollback → delete
cd ~/capturehost/backend && node scripts/integration-deploy.mjs
```

Rollback re-runs the previous successful image without rebuilding. Images are
tagged `capturehost/<slug>:<short-sha>` and pruned to `DEPLOY_KEEP_IMAGES` (3).

## Domains and Caddy

Deployed apps are reached through Caddy. The backend never edits
`/etc/caddy/Caddyfile`; it writes only routes tagged `capturehost-<id>` through
the admin API and re-applies them from SQLite on startup and every
`CADDY_SYNC_INTERVAL_MS` (an API-only change is lost when Caddy reloads).

```bash
# install (needs sudo) and start the base config
sudo pacman -S --needed caddy
sudo install -o root -g root -m 644 ~/capturehost/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy

# or, for a user-local test instance with no sudo:
caddy run --config ~/capturehost/deploy/caddy/Caddyfile --adapter caddyfile
```

| Mode | What runs | Use for |
|---|---|---|
| `local` (default) | `*.localhost` on `127.0.0.1:8080`, plain HTTP | this laptop, no DNS |
| `tunnel` | same listener, Cloudflare Tunnel terminates HTTPS | sharing privately |
| `public` | direct 80/443 + automatic HTTPS (**UNTESTED**) | only with a real domain and an open inbound port |

Attach a hostname on **Domains → Add domain** (`hello.capturehost.localhost`).
`*.localhost` resolves to this machine in every browser, so no DNS setup is
needed; open `http://hello.capturehost.localhost:8080`.

Safety rules enforced in code (`services/domains.ts`), with tests:

- an upstream is only ever `127.0.0.1:<app port>` of that project's live
  container — 2375 (Docker proxy), 2019 (admin API), 8787 (backend), 8090
  (dashboard) and anything outside `CONTAINER_PORT_RANGE_*` are refused;
- hostnames must be lowercase RFC 1123 inside `ALLOWED_BASE_DOMAINS`, with no
  wildcards, IPs, underscores or trailing dot, and cannot shadow the dashboard
  or the webhook gateway;
- the dashboard lives on its own loopback listener and is never served by the
  apps listener.

On a deploy the route is moved to the new port **before** the old container is
stopped, and the hostname is probed through Caddy. If either step fails the
route is reverted and the old container keeps serving — the deployment is
marked failed.

### Optional public webhook gateway

`WEBHOOK_PUBLIC_HOST` (off by default) lets a tunnel expose exactly
`POST /api/webhooks/github/<digits>` to the internet; everything else on that
host must 404. The HMAC signature is still verified by the backend.

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
- **Deployed containers are built from a fixed whitelist** (`containerPolicy.ts`):
  no privileged mode, no host namespaces, no bind mounts or docker socket, no
  devices, `drop: ALL` plus four allowlisted capabilities, `no-new-privileges`,
  memory/CPU/pids limits, loopback-only publishing. The finished payload is
  re-validated before it is sent, so a future caller cannot bypass the policy.
- **Git is never a shell string**: `execFile` with an argv array, `--` before the
  URL, `GIT_TERMINAL_PROMPT=0`, `credential.helper=` cleared, shallow clone, size
  and time limits, symlinks that escape the build context rejected.
- **GitHub tokens** travel through a one-time 0700 askpass script, never in the URL,
  argv or logs; they are stored encrypted with the same key as TOTP.
- **The webhook is the only public POST**: HMAC-SHA256 over the raw body with
  `timingSafeEqual`, verified before JSON parsing, branch-filtered, replay-safe.

## Layout

```
capturehost/
  backend/           Fastify API, SQLite, metrics sampler, deploy pipeline
    src/db/migrations/   numbered SQL, applied once
    src/services/        metrics, docker, containerPolicy, git, deployments
    tests/               vitest: migrations, metrics, api, auth, docker, policy, git, webhook, pipeline
    scripts/             setup/reset admin, integration checks
  frontend/          React dashboard
    src/components/      one CSS file per component
    src/pages/           Dashboard, Containers, Projects + ProjectDetail, Settings, Logs
  docker-compose.dev.yml   socket proxy + capturehost-apps network
  PROGRESS.md        phase state, decisions, how to resume
```

## Backups and restore

```bash
cd ~/capturehost/backend
npm run backup:create              # SQLite online snapshot → gzip → AES-256-GCM
npm run backup:list                # what exists, newest first
npm run backup:verify <file>       # decrypts and runs PRAGMA integrity_check
npm run backup:restore <file>      # refuses while the backend is listening
```

Backups use `BACKUP_ENCRYPTION_KEY`, which is **deliberately a different key**
from `APP_ENCRYPTION_KEY`, so leaking one does not open the other. They never
contain `.env`: store the key somewhere off this machine or the backup cannot be
restored. Restore keeps `capturehost.db.before-restore-<ts>` beside the database
and re-runs migrations. Retention keeps `BACKUP_KEEP_DAILY` daily and
`BACKUP_KEEP_WEEKLY` weekly files, deleting only `capturehost-*.db.chbk`.

The UI does the same from **Backups**: create, list, remove, and download (which
asks for the password again, is rate limited to 3/min and is audited).

## Notifications, retention and the doctor

- **Notifications** (bell page): deploy failed, scheduled backup failed, disk
  above `NOTIFY_DISK_THRESHOLD_PCT`, Caddy unreachable or drifted, a managed
  container in a restart loop or exiting unexpectedly, a domain failing three
  checks in a row (and its recovery), a login lockout per IP, and five rejected
  webhooks for one project inside ten minutes. Events dedupe by key with a
  `NOTIFY_COOLDOWN_MINUTES` window, so a restart loop pages once.
- **Outbound channel**: one `NOTIFY_WEBHOOK_URL` (ntfy, Discord, Telegram-style).
  https only, hostname resolved and private/loopback/link-local answers refused,
  redirects not followed, short timeout, URL path (the usual secret) never shown.
- **Retention** runs hourly: audit log, build logs, webhook delivery ids, login
  attempts, read notifications, expired sessions. There is no global
  `docker prune` anywhere — images are pruned per project (keep N) and on delete.
- **`npm run doctor`** (or **Security check**): admin, 2FA, cookie flags, proxy
  trust, listeners, `docker.sock` access, proxy flags, Caddy drift, keys, backup
  age, disk, `.env` mode, git tracking. Read-only, and it never prints a secret.

## Production (option A)

The backend runs as a dedicated `capturehost` system user that is **not** in the
`docker` group, with `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`,
`IPAddressAllow=localhost` and a single writable path. The proxy alone keeps a
read-only socket mount. Full sudo steps: [deploy/README.md](./deploy/README.md).

```bash
sudo install -m 644 ~/capturehost/deploy/systemd/capturehost.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now capturehost
```

## Threat model — what this does NOT protect against

- **Code you deploy.** A Dockerfile is arbitrary code run on this machine at
  build time; the container policy limits what it reaches, not what it does.
- **Docker itself.** Anyone in the `docker` group is root-equivalent. The backend
  avoids the socket, but the proxy still allows create/start/remove, so a
  compromised backend controls containers.
- **A compromised host user.** Secrets are in `.env` (mode 600, checked by the
  doctor). Read access to it is equivalent to the app's keys.
- **Network attackers** are outside the model only because every listener is on
  loopback. Bind anything to `0.0.0.0` and that assumption disappears.
- **Not multi-tenant**: one admin, one machine, no per-user isolation.
- Backups survive a corrupt database, not a host compromised while the backup key
  sits on it.

## Forgot the password?

Passwords are stored as one-way argon2id hashes, so there is nothing to read
back — only to check. Prefer the offline check over guessing at the login form:
five wrong attempts lock the IP out for 15 minutes and raise an alert.

```bash
cd backend
npm run check:password                                  # dev database
npm run check:password -- --db /var/lib/capturehost/capturehost.db   # production
printf 'candidate\n' | npm run check:password           # non-interactive
```

Exit code 0 means it matches, 1 means it does not, 2 means no database or no
admin. The password is not echoed and never leaves the machine.

To rotate it, use **Settings → Security → Change password** in the dashboard, or
from a shell when the dashboard is unreachable:

```bash
cd backend
npm run change:password                                  # asks for current, then new (both hidden)
npm run change:password -- --db /var/lib/capturehost/capturehost.db
```

It verifies the current password, applies the same strength rules as the web form,
rewrites only the hash, revokes every session (you sign in again) and writes an
audit row. **2FA and the recovery codes are untouched** — unlike `reset:admin`,
which deletes the account, its sessions and its TOTP secret, and then needs
`setup:admin` to start over.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Caddy is not reachable` | `systemctl status caddy`; admin API must be on `127.0.0.1:2019` |
| Deploy: `network … not found` | `docker compose up -d` (creates `capturehost-apps`) |
| Deploy: `Dockerfile missing` | path is relative to the repo root and must exist on that branch |
| Domain 404 | project has no live container, or the domain is disabled |
| Domain 502 | the container died after the swap — check Containers → logs |
| `Too many attempts` on login | lockout is per IP **and** per username |
| Everything looks like 127.0.0.1 | behind Caddy: `TRUST_PROXY=true`, keep `TRUST_PROXY_ADDRESSES` loopback |
| Doctor: `.env` mode 644 | `chmod 600 backend/.env` |
| Doctor: 2FA off | Settings → Security → Enable 2FA |
