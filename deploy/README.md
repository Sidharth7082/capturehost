# Deployment (option A — systemd, dedicated user)

This is the recommended production setup. The backend runs as an unprivileged
system user that is **not** in the `docker` group, so the socket proxy is the
only way it can reach Docker. Caddy stays a normal system service, which keeps
its unauthenticated admin API on loopback.

Paths used below:

| Thing | Path |
|---|---|
| Code | `/opt/capturehost` |
| Data (SQLite, deployments, backups) | `/var/lib/capturehost` |
| Secrets | `/etc/capturehost/capturehost.env` (mode 600, root-owned) |
| Service | `/etc/systemd/system/capturehost.service` |

## 1. Runs these yourself (they need sudo)

```bash
# a dedicated, shell-less system user — NOT added to the docker group
sudo useradd --system --home-dir /var/lib/capturehost --create-home --shell /usr/sbin/nologin capturehost

# code
sudo install -d -o capturehost -g capturehost /opt/capturehost
sudo cp -a ~/capturehost/. /opt/capturehost/
sudo chown -R root:root /opt/capturehost
sudo chown -R capturehost:capturehost /var/lib/capturehost

# build the backend as the service user would run it
cd /opt/capturehost/backend && sudo -u capturehost npm ci && sudo -u capturehost npm run build

# secrets: start from the example, then fill it in
sudo install -d -m 700 -o root -g root /etc/capturehost
sudo install -m 600 -o root -g root ~/capturehost/backend/.env.example /etc/capturehost/capturehost.env
sudoedit /etc/capturehost/capturehost.env     # DB_PATH=/var/lib/capturehost/capturehost.db, etc.

# the unit
sudo install -m 644 ~/capturehost/deploy/systemd/capturehost.service /etc/systemd/system/capturehost.service
sudo systemctl daemon-reload
sudo systemctl enable --now capturehost
sudo systemctl status capturehost --no-pager
```

## 2. The proxy must keep running

```bash
cd /opt/capturehost && sudo docker compose -f docker-compose.yml up -d
```

`docker-compose.yml` contains the socket proxy and the `capturehost-apps`
network — nothing else. The backend is a systemd service, not a container.

## 3. Caddy

```bash
sudo cp ~/capturehost/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
```

## 4. Verify

```bash
curl -s http://127.0.0.1:8787/api/health            # {"status":"ok",...}
ss -ltn | grep -E ':8787|:2019|:8080|:8090|:2375'   # all 127.0.0.1
sudo -u capturehost ls /proc/$(pgrep -f 'node /opt/capturehost' | head -1)/fd | grep -c docker.sock  # 0
sudo -u capturehost env -i PATH=/usr/bin node /opt/capturehost/backend/dist/scripts/ops.js doctor
```

## 5. Upgrading

```bash
cd /opt/capturehost && sudo git pull
cd backend && sudo -u capturehost npm ci && sudo -u capturehost npm run build
sudo systemctl restart capturehost      # migrations run at startup
```

Downtime is a few seconds; deployed sites keep serving because Caddy and the
containers are untouched.

## 6. Why not a container (option B)

See `DESIGN-NOTE.md`. In short: to keep Caddy's unauthenticated admin API off
any shared network, Caddy has to stay outside the container, and then the only
thing a container adds is image rebuilds on every dependency change.
