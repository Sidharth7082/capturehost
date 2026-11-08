# How to run the backend in production — two options

Everything below assumes Caddy stays a system service: it must bind :80/:443 in
public mode, and the admin API has no authentication, so it belongs to a
privileged-but-Local-only service either way.

## A. systemd service, dedicated system user (recommended)

`capturehost` user, no shell, **not** in the `docker` group. Unit hardening:
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`,
`PrivateTmp`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, `MemoryMax`,
`ReadWritePaths=/var/lib/capturehost` (SQLite, deployments, backups).

| Concern | How it works |
|---|---|
| git + docker builds | run as `capturehost`; both need only network + the proxy |
| Docker proxy | `DOCKER_HOST_URL=http://127.0.0.1:2375` (loopback, proxy already running) |
| Caddy admin | `http://127.0.0.1:2019`, loopback, unchanged |
| Data | `/var/lib/capturehost` — one directory, `chown capturehost:` |
| Caddy | system service (same as now) |
| Upgrades | `git pull && npm ci && npm run build && systemctl restart capturehost` |
| If compromised | the process is unprivileged and outside the docker group: it can reach the proxy **only** through its URL and cannot open `/var/run/docker.sock`, cannot write outside its data dir, cannot see `$HOME` |

Cost: one unit file, one user, a `chown`. Node and npm come from the system.

## B. backend in a compose container (no socket)

Container on an internal network with the proxy and Caddy; no host mounts
except the data volume.

| Concern | How it works |
|---|---|
| git + docker builds | inside the image (needs git, tar, node); builds talk to the proxy |
| Docker proxy | `http://docker-socket-proxy:2375` on the internal network |
| Caddy admin | `http://caddy:2019` on the internal network — **only** works if Caddy is also in compose |
| Data | named volume |
| Caddy | must move into compose too (its admin API is then on a shared network) |
| Upgrades | `docker compose build && docker compose up -d`; image rebuild on every dependency change |
| If compromised | same proxy access as A, plus the container can reach Caddy's unauthenticated admin API over the shared network — a second, weaker boundary than A's loopback-only one |

Cost: Caddy has to be containerised as well (losing the system package and the
`/etc/caddy` ownership model you already have), the image must carry git/tar,
and the Docker-out-of-Docker build path gets harder to reason about.

## Recommendation

**A.** It gives the same "cannot touch the socket, cannot write outside its own
directory" boundary with strictly fewer moving parts, keeps Caddy a normal
system service (so the admin API stays loopback-only), and upgrades are a
`git pull`. B only wins if you later want to move CaptureHost to another host
wholesale.
