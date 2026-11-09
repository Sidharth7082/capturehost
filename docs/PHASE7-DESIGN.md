# Phase 7 — Databases: design note (awaiting your choice)

| Area | Decision | Why |
|---|---|---|
| Storage | Docker **named volume only**, `capturehost-db-<id>` → `/var/lib/postgresql/data` | survives container recreate; no host path ever mounted |
| Backups | **helper container** (`pg_dump -Fc`) + archive transfer, no EXEC | `pg_dump` is not installed on this machine and we have no sudo |
| Exposure | internal on `capturehost-apps`; **optional** published `127.0.0.1:<port>` | never `0.0.0.0` |
| Credentials | server-generated 32-char, encrypted with `APP_ENCRYPTION_KEY`, shown **once** | `docker inspect` will still show it in the container env — that is Postgres' own requirement |
| Isolation | keep **one shared network** this phase | per-project networks cost a lot and buy little while credentials are the boundary |
| Scope | **Postgres only**, pinned tags `16-alpine`, `17-alpine` | no MySQL/Redis/Supabase/SQL console |

## 1. Persistent storage — the policy change
Today `containerPolicy.ts` sets `Binds: []` and the validator refuses any `Binds`/`Mounts`. The extension, in one place:
- allow exactly one bind of the form `<prefix>` + the container's own database id → the image's data path, where `<prefix>` is a constant `capturehost-db-`;
- still refuse: host paths (`/…`, `./…`), `docker.sock`, `:ro`/`:rw` tricks, `Mounts`, `Privileged`, `Devices`, `PidMode`, `CapAdd` beyond the four.
- **Socket proxy stays `VOLUMES: 0`.** Docker creates a named volume implicitly at container create, so create/start/stop need no new flag. Cost: deleting the volume through the API needs `VOLUMES: 1`, so *delete database* removes the container and leaves `capturehost-db-<id>` behind — the doctor reports it and the operator runs `docker volume rm`. I recommend keeping it at 0: `VOLUMES: 1` would let this process delete **any** volume on the box, including yours. `EXEC` stays 0, `NETWORKS` stays 0.

## 2. Backups and restore without EXEC
- (a) **helper container** — create the same pinned image with `pg_dump -Fc -U capturehost -d <db> -f /tmp/dump`, `PGPASSWORD` in env, on `capturehost-apps`, start, wait; then `GET /containers/{id}/archive?path=/tmp/dump` (allowed under `CONTAINERS: 1`) → tar → host. Two container lifecycles per backup, no new proxy flag, no host package.
- (b) **host binary** against a loopback port — simpler code, but `pg_dump` is not installed and installing it is a sudo step for you. Fallback if you prefer it.
- Encryption: existing `secretbox` with `BACKUP_ENCRYPTION_KEY`, `.chbk` files at `data/databases/<id>/`, same retention shape as `BACKUP_KEEP_*`.
- Verify: `pg_restore --list` in a helper (fast sanity), and a real restore always creates a **new** database (create → `putArchive` the decrypted dump → `pg_restore -d <new>`), never in place.

## 3. Network exposure
Default: internal only, no published port, reachable by containers as `capturehost-db-<id>:5432`. Optional "open to my laptop" toggle publishes `127.0.0.1:<port from the app range>`; the upstream policy refuses anything not bound to loopback.

## 4. Credentials
`POSTGRES_USER=capturehost`, 32-char base64url password, encrypted at rest (context `database.password`), returned in the create response **once** and then only masked, with a rotate action. Honest limit: it is in the container env, so `docker inspect` and `ps e` on this machine show it to you (and root). Our API, UI, logs, audit and backups never contain it; tests scan all four.

## 5. Isolation
Every app is on one network, so any app can *reach* every database port. It cannot authenticate without that database's password, so the credential is the real boundary; a compromised app gains port reachability and scanning, not data. Per-project networks would need `NETWORKS: 1`, container recreation on link, and route plumbing — not worth it for one operator. Revisit if two people ever share this box.

## 6. Scope
Postgres only: allowlist `16-alpine`/`17-alpine` (immutable-ish tags), `pg_isready` healthcheck, memory 512 MB default (max 4096) and CPU 0.5 (max 4) through the existing clamps, labels `capturehost.managed` + `capturehost.database`, hidden from the generic Containers delete.

## Three things I need from you
1. **Backups:** helper container (a), or install `postgresql-client` and use (b)?
2. **Volume deletion:** keep `VOLUMES: 0` (orphan volume, manual prune, doctor nags), or enable `VOLUMES: 1` so delete can drop the volume (and accept that this process could delete any volume)?
3. **Published port:** include the "open to my laptop" toggle in this phase, or defer?
