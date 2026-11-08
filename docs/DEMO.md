<p align="center"><img src="brand/header.png" alt="CaptureHost" width="100%"></p>

# CaptureHost — 7-minute demo

For a BCA project review. Everything here runs on one laptop, uses **only the
test repository and scratch files**, and puts **no password and no key on
screen**. If a terminal is being mirrored, close anything with secrets in it
first (`~/.zsh_history`, `backend/.env`, a password manager) — nothing below
requires them.

Prep, done before the demo starts:

```bash
# 1. backend + frontend running
cd ~/capturehost/backend  && npm run dev          # :8787
cd ~/capturehost/frontend && npm run dev          # :5173

# 2. socket proxy + Caddy up
cd ~/capturehost && docker compose -f docker-compose.dev.yml up -d
caddy run --config deploy/caddy/Caddyfile --adapter caddyfile &

# 3. a second terminal with a shell in ~/capturehost, font size up
```

---

> Adding a project of your own, field by field: [ADD-YOUR-PROJECT.md](ADD-YOUR-PROJECT.md).

## Minute 0–1 — What it is

Open `http://127.0.0.1:5173`.

> "This is a hosting dashboard for one machine. It monitors the box, manages
> Docker, deploys a GitHub repo, and puts a hostname in front of it. Built with
> Fastify + SQLite on the backend, React on the frontend, Caddy as the proxy."

Point at the live cards: CPU, RAM, disk, network, GPU, all updating every 2 s
over one WebSocket. Let it sit for a few seconds so the chart moves.

## Minute 1–2 — It is not unauthenticated

Click the avatar → **Security settings**. Show: 2FA enabled, active sessions,
audit log tail.

> "Every API route needs a session; every write needs a CSRF token bound to that
> session; the login flow is rate limited per IP *and* per username."

Optional, 15 seconds: open `http://127.0.0.1:5173/api/projects` in a new tab and
show the 401.

## Minute 2–3 — Deploy from GitHub

**Projects → New Project** → name `demo-app`, repo
`https://github.com/Sidharth7082/capturehost-test-app`, branch `main`,
Dockerfile `Dockerfile`, port `80` → Create. Press **Deploy**.

Talk over the live log as it streams: clone → build → start → health check →
swap.

> "The new container is health-checked while the old one still serves. Only then
> does the route move and the old container stop. If the health check fails, the
> old one keeps serving and the deployment is marked failed."

## Minute 3–4 — Hostname through Caddy

**Domains → Add domain** → `demo-app.capturehost.localhost` → Add. Open it in a
new tab (`http://demo-app.capturehost.localhost:8080`).

Then in the terminal, show the route Caddy actually holds:

```bash
curl -s -H "Origin: http://127.0.0.1:2019" http://127.0.0.1:2019/config/ \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).apps.http.servers.srv0.routes) console.log(r["@id"], JSON.stringify(r.handle?.[0]?.upstreams ?? "catch-all"))})'
```

> "Routes are tagged with the domain id and rebuilt from SQLite, so a Caddy
> reload cannot lose them."

## Minute 4–5 — Safety you can attack

```bash
cd ~/capturehost/backend && npm run doctor
```

> "These are the checks a compromised config would fail: 2FA, cookie flags,
> listeners on loopback, no `docker.sock` in the process, the proxy's flags,
> Caddy drift, key presence, backup age, `.env` permissions."

Then show the same refusal in one command — it tries to route a hostname at the
Docker proxy's own port:

```bash
cd ~/capturehost/backend && npx tsx -e "
import { buildAppRoute } from './src/services/domains.js';
try {
  buildAppRoute({ id: 1, hostname: 'x.capturehost.localhost' }, 2375,
    { portRangeStart: 8100, portRangeEnd: 8999, forbiddenPorts: [2375, 2019, 8787] });
  console.log('ALLOWED — that would be a bug');
} catch (error) {
  console.log('refused:', (error as Error).message);
}
"
```

> "Privileged containers, host networking and socket mounts are refused in the
> same way, with tests that try to sneak them in." 

## Minute 5–6 — Break it, then roll back

In the test repo on GitHub, change `Dockerfile` to `FROM nginx:alpine` plus a
broken line (`RUN exit 1`), commit and push. In the dashboard press **Deploy**.

> "The build fails. The site is still up — the old container was never touched."

Show **Deployments**: the failed row with its log. Fix the Dockerfile, push
again, redeploy, then press **Rollback** and show it re-running the previous
image without rebuilding.

## Minute 6–7 — Backups and the honest limits

**Backups → Back up now** (do **not** press Download on a projector — it asks for
the password).

```bash
cd ~/capturehost/backend && npm run backup:list
npm run backup:verify "$(ls -1t data/backups/*.chbk | head -1)"
```

> "Encrypted with a key that is different from the app key, integrity-checked on
> write and on verify, and restorable with `backup:restore` into a scratch
> database. Backups never contain `.env`."

Close with the limits, plainly:

- one machine, one admin — not multi-tenant;
- Dockerfile-only; no buildpack detection;
- `public` HTTPS mode is written but untested — the laptop demo uses
  `*.localhost`;
- deploy only repos you trust: the build runs that repo's code here;
- a compromised backend still controls containers through the proxy.

Cleanup afterwards (removes only this demo's project and its image):

```bash
# Projects → demo-app → Danger zone → delete (or the API DELETE with the name)
docker images | grep capturehost/demo-app
```
