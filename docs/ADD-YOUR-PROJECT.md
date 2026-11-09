# Adding and running your own project

This is the operator's guide: how a person takes a repository they own and gets it
running behind a hostname on CaptureHost. It describes the dashboard as it is
built today, including the parts that will bite you.

If you only want to know how to *start the dashboard itself*, that is
[the README](../README.md#run-everything-with-one-command).

---

## Before you start: what the project needs

CaptureHost does not generate anything for you. Four things have to be true of the
repository **before** you press Deploy:

| Requirement | Why |
|---|---|
| A **GitHub repository you own**, reachable over HTTPS | Only `https://github.com/owner/repo` is accepted. SSH URLs and other hosts are refused by schema. |
| A **`Dockerfile` in the repository** | Default path `Dockerfile`, or any other path you set. Nothing is generated, and buildpack-style detection does not exist. |
| The app **listens on the container port you declare** (default `80`), on `0.0.0.0` | CaptureHost publishes `127.0.0.1:<hostPort>` → `<containerPort>` and health-checks through it. It does **not** inject a `PORT` variable. An app bound to `127.0.0.1` *inside* the container is unreachable. |
| No expectation of **persistent writes** | No volumes are ever mounted. The container starts fresh from the image on every deploy; anything written inside is lost on the next one. |

Two more things worth knowing before you invest time:

- **The build runs on this laptop.** A heavy build (a full Rust or Java toolchain)
  will take minutes and make the machine warm. Keep images small.
- **Only deploy repositories you trust.** The Dockerfile is executed here. The
  container is locked down (see [limits](#what-the-container-can-and-cannot-do)),
  but the build is not sandboxed.

---

## Step 1 — create the project

**Projects → New project.** The form asks for:

| Field | Default | Notes |
|---|---|---|
| **Name** | — | A lowercase slug. It becomes the container name, the image tag (`capturehost/<slug>:<sha>`) and part of the URL. `my-site`, not `My Site`. |
| **Repository** | — | `https://github.com/owner/repo`. |
| **Branch** | `main` | Only this branch is cloned (shallow, single branch, no tags). |
| **Container port** | `80` | Must match what your app listens on. |
| **Dockerfile path** | `Dockerfile` | Relative to the repository root. |
| **GitHub token** | empty | Only for **private** repositories. Stored encrypted, never shown again. Leave empty for public ones. |
| **Resource limits** (collapsed) | 512 MB, 0.5 CPU | Memory max 4096 MB, CPU max 4. Pids are fixed at 256. |

The project is created in an `idle` state — nothing is cloned or built yet.

---

## Step 2 — deploy it

Open the project and press **Deploy** (or use Deploy now in the Projects table).

A deployment walks through these states, and the log is streamed live:

```
queued → cloning → building → starting → health-check → live
                                              ↘ failed
                cancelled / rolled-back are reachable from most states
```

What each step means, and what failure there tells you:

| State | Happening | If it fails |
|---|---|---|
| `cloning` | shallow clone of your branch into a fresh directory | bad URL, missing token, or the repository is larger than the 200 MB cap |
| `building` | `docker build` with your Dockerfile, 15-minute timeout | read the build log: the error is the last real line, not the last line |
| `starting` | a new container from the built image, on a **fresh host port** | entrypoint crash — the container logs are in the deploy log |
| `health-check` | container still running twice, ~1s apart, or `healthPath` returning 2xx | "restart loop" means your process exits immediately; "did not pass" means nothing was listening |
| `live` | the Caddy route (if a domain is attached) now points at the new container, and the old one is removed | — |

**Blue/green:** every deploy gets a new container and a new host port; the old
container keeps serving until the new one is healthy. A failed deploy removes the
new container and leaves the previous one live — you do not take the site down by
trying. One build runs at a time; a second deploy is queued.

You can **Cancel** a deployment while it is building or checking.

---

## Step 3 — open it

The project Overview shows something like **Serving 127.0.0.1:8101**. That is the
host port bound on loopback: `http://127.0.0.1:8101` works from this machine, and
nothing else. The port changes on every deploy (that is what makes blue/green
possible), so use the number on the Overview rather than remembering one.

---

## Step 4 — give it a hostname

**Domains → Add domain.**

- The hostname must end with one of the **allowed base domains**. In the default
  local mode that is `.localhost`, i.e. `my-site.capturehost.localhost`.
- In local mode the name resolves to this machine with **no DNS setup**, which is
  why it is the path of least resistance. Open it at the Caddy apps listener:
  `http://my-site.capturehost.localhost:8080` — not on port 80.
- `http://` only in local mode. HTTPS needs `Caddyfile.public`, a real domain and
  DNS that points at you; that path is written up in
  [deploy/README.md](../deploy/README.md) and is **untested**.

Attaching the domain is not enough on its own: the route points at the project's
**current** container, so a deploy (or rollback) afterwards moves the hostname with
it. Deleting the domain removes the route and the hostname starts returning 404.

---

## Step 5 — environment variables

**Project → Environment.** Add `KEY` / `value` pairs.

- Values are **write-only**: the API returns key names, never values, and the UI
  cannot read them back.
- They are applied to the container at the next deploy, not live. Change them,
  then press Deploy.
- `DATABASE_URL`, `NODE_ENV`, API tokens — this is the place. Nothing is written
  into the image.

---

## Step 6 — deploy on push (optional)

**Project → Settings → Webhook** shows a per-project URL and a secret.

1. GitHub → your repository → Settings → Webhooks → Add webhook.
2. Payload URL: what the settings panel shows.
3. Content type: `application/json`.
4. Secret: the value from the panel.
5. Events: push (and optionally pull request closed).

The signature is HMAC-SHA256 over the raw body and is verified before anything is
parsed; deliveries are deduplicated by `X-GitHub-Delivery`, so a retry does not
deploy twice.

**The catch:** the backend listens on `127.0.0.1` only, so GitHub cannot reach it
directly. Until you expose `/api/webhooks/github/<project id>` through a tunnel
(Cloudflare Tunnel / Tailscale Funnel), use the Deploy button instead.

---

## Rollback

**Project → Deployments → a previous deployment → Rollback.** It reuses the image
that deployment built — no rebuild — starts it on a fresh port, health-checks it,
moves the hostname and removes the current container. Use it when a new build is
broken and you want the previous one back in seconds.

Image retention keeps the last 3 images per project (`DEPLOY_KEEP_IMAGES`), so very
old deployments cannot be rolled back to once they age out.

---

## What the container can and cannot do

Every container is built by `services/containerPolicy.ts` — the only place a
container config is produced — and re-validated before it is sent to Docker.

**Cannot:** be privileged, use host networking / PID / IPC, mount a bind or a
volume, get a device, reach the Docker socket, or add any capability outside
`NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID`. There is no exec-into-container
endpoint and no way to create a container from the UI.

**Limits:** memory and swap are equal (no swap headroom), CPU is a nano-cpu quota,
256 pids, `no-new-privileges`, restart `unless-stopped`, published on
`127.0.0.1` only, labelled `capturehost.managed=true`.

Practical consequences: an app that needs to run as a different user needs `CHOWN`
(nginx:alpine needs all four of the allowed ones, which is why they exist); an app
that wants to write to a host directory has no supported way to do it yet.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No Dockerfile at "…" in this repository` | wrong **Dockerfile path** | point it at the real file, relative to the repo root |
| `Container is in a restart loop` | the process exits straight after start | open the deploy log; usually a missing env var or a wrong `CMD` |
| `Health check did not pass within 30s` | nothing listening on the declared container port, or bound to `127.0.0.1` inside the container | bind `0.0.0.0:<container port>` and make the two match |
| `port is already allocated` in the log, deploy continues | the next free host port was taken mid-swap | nothing; the pipeline retries with the next port |
| The hostname gives 404 | no domain attached, or the project has no live container | Domains tab; then Overview → Serving |
| The hostname gives 502 | the container is down behind an attached route | redeploy, or check the container's logs |
| An env change had no effect | env vars apply at deploy time | press Deploy |
| `clone failed`, private repo | no token | add a GitHub token to the project |

---

## Two minimal examples

### A static site

```dockerfile
# Dockerfile — container port 80
FROM nginx:alpine
COPY . /usr/share/nginx/html
```

Create the project with **container port 80** (the default). `nginx:alpine` needs
the four allowed capabilities to `chown` its temp directories; that is already
handled by the policy.

### A Node service

```dockerfile
# Dockerfile — container port 8080
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
```

Set **container port 8080** in the project to match. Bind to `0.0.0.0`, not
localhost:

```js
app.listen(8080, '0.0.0.0');
```

---

## A worked example that exists on this machine

`Sidharth7082/capturehost-test-app` is deployed here as project `hello-capturehost`:

- repository `https://github.com/Sidharth7082/capturehost-test-app`, branch `main`
- container port 80, Dockerfile at the root (a static nginx page)
- hostnames: `hello.capturehost.localhost` locally
  (`http://hello.capturehost.localhost:8080`) and `demo.captureordie.online`
  publicly (`https://demo.captureordie.online`, through the Cloudflare Tunnel)
- Overview shows the current `127.0.0.1:<port>`; Deployments lists its history,
  including the failed builds from tuning the Dockerfile.

Copy that shape for your first project: smallest possible Dockerfile, one page,
get it live, then add env vars and a domain.

---

## Known gaps in this flow

Honest list, so you do not go looking for features that are not there:

- **`healthPath` is not exposed in the UI.** The API accepts it and the probe uses
  it, but the form does not ask for one, so health is "the process stayed up". A
  project that needs a real readiness URL has to set it through the API.
- **No volumes, no compose, no multi-service projects, no build args.**
- **Webhooks need a tunnel** before GitHub can reach them.
- **Public/HTTPS mode is untested**; local mode is HTTP on port 8080.
- **The deployment queue is in memory.** A backend restart drops queued builds; the
  row stays `queued` and can be cancelled.
