# Deployment (option A — systemd, dedicated user)

The backend runs as an unprivileged system user that is **not** in the `docker`
group, so the socket proxy is the only way it can reach Docker. Caddy stays a
normal system service, which keeps its unauthenticated admin API on loopback.

Production has **its own database**, so it starts with no admin, no projects and
no domains. Everything you created in the dev instance is separate from this and
is thrown away at the end (step 12).

| Thing | Path | Owner / mode |
|---|---|---|
| Code | `/opt/capturehost` | `root:root`, read-only to the service |
| Data (SQLite, deployments, backups) | `/var/lib/capturehost` | `capturehost:capturehost` |
| Secrets | `/etc/capturehost/capturehost.env` | `capturehost:capturehost`, 600 |
| Service | `/etc/systemd/system/capturehost.service` | `root:root`, 644 |

Everything below needs sudo, so run it yourself, one block at a time.

## 1. Stop the dev instance

Two processes hold the ports production needs.

```bash
# backend (:8787) and vite (:5173) — Ctrl-C in their terminals, or:
pkill -f 'tsx watch src/index.ts'
pkill -f 'vite'

# the dev Caddy from ~/.local/bin holds :2019, :8080 and :8090
pkill -f 'caddy run --config'
ss -ltn | grep -E ':8787|:2019|:8080|:8090' || echo "ports free"
```

The dev socket proxy can stay up — production uses the same container.

## 2. User, code, build

```bash
sudo useradd --system --home-dir /var/lib/capturehost --create-home --shell /usr/sbin/nologin capturehost
sudo install -d -o capturehost -g capturehost /opt/capturehost

sudo cp -a ~/capturehost/. /opt/capturehost/
# do NOT carry dev state across: the dev .env would shadow the real secrets and
# backend/data/ is a dev database full of test projects
sudo rm -f  /opt/capturehost/backend/.env
sudo rm -rf /opt/capturehost/backend/data

sudo chown -R root:root /opt/capturehost
sudo chown -R capturehost:capturehost /var/lib/capturehost
cd /opt/capturehost/backend && sudo -u capturehost npm ci && sudo -u capturehost npm run build
# the build leaves node_modules owned by the service user; give it back so the
# running service cannot rewrite its own code
sudo chown -R root:root /opt/capturehost
```

## 3. Secrets — generate new keys, do not copy the dev ones

```bash
sudo install -d -m 750 -o root -g capturehost /etc/capturehost
sudo install -m 600 -o capturehost -g capturehost \
  ~/capturehost/backend/.env.example /etc/capturehost/capturehost.env

# two fresh keys, different from the dev ones
openssl rand -base64 32   # APP_ENCRYPTION_KEY   — TOTP secrets, project env vars, GitHub tokens
openssl rand -base64 32   # BACKUP_ENCRYPTION_KEY — backup blobs
sudoedit /etc/capturehost/capturehost.env
```

**Put both keys in your password manager now, before anything else.** Backups are
encrypted with `BACKUP_ENCRYPTION_KEY` and never contain `.env`; if the laptop
dies and that key is gone, the backups are unreadable. The same is true of
`APP_ENCRYPTION_KEY` for restored project env vars and 2FA secrets.

Three paths in that file must be absolute, because the service's working
directory is read-only under `ProtectSystem=strict`:

```bash
DB_PATH=/var/lib/capturehost/capturehost.db
DEPLOY_DATA_DIR=/var/lib/capturehost/deployments
BACKUP_DIR=/var/lib/capturehost/backups
```

systemd reads `EnvironmentFile` as root before dropping privileges, so a
`capturehost`-owned 600 file works for the service *and* for the CLIs you run as
that user.

## 4. Create the production admin — before the service starts

There is no signup endpoint; the first account comes from a shell command.

```bash
sudo -u capturehost bash -c '
  set -a; . /etc/capturehost/capturehost.env; set +a
  cd /opt/capturehost/backend && npm run setup:admin
'
```

It prompts for a username and a password (typed blind, twice). Type the password
yourself — do not paste it into a chat, a script or this repo. It refuses if an
admin already exists; `npm run reset:admin` deletes the account first.

## 5. Install and start the service

```bash
sudo install -m 644 /opt/capturehost/deploy/systemd/capturehost.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now capturehost
sudo systemctl status capturehost --no-pager     # active (running)
journalctl -u capturehost -n 30 --no-pager
```

Migrations run at startup, so the database is created on first boot.

## 6. The socket proxy

```bash
cd /opt/capturehost && sudo docker compose -f docker-compose.yml up -d
docker ps --filter label=capturehost.protected=true    # the proxy, on 127.0.0.1:2375
```

`docker-compose.yml` holds the proxy and the `capturehost-apps` network, nothing
else. The backend is a service, not a container.

## 7. Caddy as a system service

The dev copy in `~/.local/bin` does not survive a reboot.

```bash
sudo pacman -S caddy
sudo cp /opt/capturehost/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
ss -ltn | grep -E ':2019|:8080|:8090'
```

## 8. Verify

```bash
# isolation: no docker group, and no way to reach the daemon socket directly
id capturehost                          # groups must NOT include docker
sudo -u capturehost docker ps           # must fail: permission denied
sudo -u capturehost ls /proc/$(pgrep -f 'node /opt/capturehost' | head -1)/fd | grep -c docker.sock   # 0

curl -s http://127.0.0.1:8787/api/health        # {"status":"ok",...}
ss -ltn | grep -E ':8787|:2019|:8080|:8090|:2375'   # every listener on 127.0.0.1

sudo -u capturehost bash -c '
  set -a; . /etc/capturehost/capturehost.env; set +a
  cd /opt/capturehost/backend && npm run doctor
'
```

`doctor` should report **0 failures**. Warnings about dev defaults are expected
before you set a real password and 2FA.

## 9. First login, 2FA, first deploy

1. Open `http://capturehost.localhost:8090` (or `http://127.0.0.1:8787`).
2. **Settings → Security**: enable 2FA immediately, and store the recovery codes
   in the password manager — not on this laptop.
3. **Projects → New project** with the test repo
   (`https://github.com/Sidharth7082/capturehost-test-app`), then **Deploy**.

The sandbox is the risk here: if git or a build step fails, the error usually
names a path that is not writable. `journalctl -u capturehost -n 50` shows it.

## 10. First backup, off the laptop

**Backups → Back up now**, then **Download** (it asks for your password), then
copy that `.chbk` file somewhere else — a USB stick or a cloud folder. Backups
live on the same disk as the data until you move one.

```bash
ls -l /var/lib/capturehost/backups/
```

## 11. Reboot test

```bash
sudo systemctl reboot
# after it comes back:
systemctl status capturehost caddy --no-pager
docker ps --filter label=capturehost.protected=true
curl -s http://127.0.0.1:8787/api/health
```

All three (Caddy, the proxy container, the backend) must come back on their own.

## 12. Retire the dev instance

Once production works, the dev database is dead weight and holds stale test
projects:

```bash
cd ~/capturehost && pkill -f 'tsx watch' ; pkill -f vite
mv backend/data ~/capturehost-dev-data-$(date +%F)   # or delete it
```

Keep `~/capturehost` as your working tree for development; production runs from
`/opt/capturehost`.

## 13. Upgrading

```bash
cd /opt/capturehost
sudo git pull                      # or rsync from your working tree
cd backend && sudo -u capturehost npm ci && sudo -u capturehost npm run build
sudo chown -R root:root /opt/capturehost
sudo systemctl restart capturehost  # migrations run at startup
```

Downtime is a few seconds; deployed sites keep serving because Caddy and the
containers are untouched.

## 14. When something fails

```bash
journalctl -u capturehost -n 50 --no-pager     # startup and runtime errors
systemd-analyze security capturehost           # how the sandbox scores
```

The usual suspects, in order of likelihood:

| Symptom | Cause |
|---|---|
| `EACCES` on a path under `/var/lib/capturehost` | `ReadWritePaths` or ownership — `sudo chown -R capturehost:capturehost /var/lib/capturehost` |
| Owner of a config file is not `capturehost` | the CLI run as that user cannot read it: `sudo chown capturehost:capturehost /etc/capturehost/capturehost.env` |
| Service starts then exits immediately | `config` validation — an empty or short `APP_ENCRYPTION_KEY` / `BACKUP_ENCRYPTION_KEY`; `journalctl` names the field |
| `connect ECONNREFUSED 127.0.0.1:2375` | the proxy container is down: `docker compose -f docker-compose.yml up -d` |
| `git clone` times out only under systemd | the clone is outbound HTTPS, so an egress filter in the unit would drop it. The unit ships without `IPAddressAllow`/`IPAddressDeny` for this reason. `docker pull` still works because it happens in the daemon, not in this cgroup — which is why a first deploy can succeed on the image and fail on the clone |
| `git` or `docker build` fails on a path | something outside `ReadWritePaths=/var/lib/capturehost` |
| OOM kill during a large build | raise `MemoryMax` in the unit |

## 15. Why not a container (option B)

See `DESIGN-NOTE.md`. In short: to keep Caddy's unauthenticated admin API off any
shared network, Caddy has to stay outside the container, and then the only thing
a container adds is image rebuilds on every dependency change.
