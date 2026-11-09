# Deployable examples

Two minimal API backends that deploy on CaptureHost as-is. Both were built and run
against the real container policy (refused capabilities, non-root, loopback publish)
before being committed.

| Directory | Stack | Container port | Notes |
|---|---|---|---|
| `fastapi-api/` | FastAPI + uvicorn on Python 3.12 | **8000** | runs as `appuser` (uid 10001) |
| `express-api/` | Express 4 on Node 22 alpine | **8080** | runs as `node` |

Both listen on `0.0.0.0` and read `$PORT`, expose `GET /health` and
`GET /api/hello`, and report whether `DATABASE_URL` is present (presence only —
never echo a connection string).

## Use them

1. Copy the directory into a repository of your own (e.g. `fastapi-api/` → the root
   of a new repo) and push it.
2. In CaptureHost: **New project** → the repo → branch → **container port 8000**
   (FastAPI) or **8080** (Express). The Dockerfile is at the repository root.
3. Deploy, then attach a hostname — `api.captureordie.online` — and the service is
   live over HTTPS.

## Verify locally, exactly as the platform will run it

```bash
docker build -t example-fastapi ./fastapi-api
docker run --rm -p 127.0.0.1:8801:8000 --cap-drop ALL \
  --security-opt no-new-privileges:true example-fastapi

curl -s http://127.0.0.1:8801/health        # {"status":"ok"}
curl -s 'http://127.0.0.1:8801/api/hello?name=capturehost'
```

Run in this order, they answered `200` with
`{"hello":"capturehost","database_linked":false,"port":8000}` (FastAPI) and
`{"hello":"capturehost","databaseLinked":false}` (Express), with `Config.User` set
to `appuser` / `node` and `CapDrop: ["ALL"]`.

## What the platform does not give an API

- **No persistent disk** — write state to a linked database, not to the container.
- **One port** — a second listener is unreachable; gRPC is not proxied (HTTP/1.1 only).
- **One instance** — no replicas or autoscaling; background work belongs in the same
  process.
- **Public once it has a hostname** — authentication inside your API is yours to add.
