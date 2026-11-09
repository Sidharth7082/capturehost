# Supabase, mapped onto CaptureHost

Supabase is a platform, not a feature: an Envoy gateway in front of **Studio** (dashboard),
**GoTrue** (JWT auth), **PostgREST** (auto REST), **Realtime** (Elixir WS), **Storage**
(S3-compatible), **Deno edge functions**, **postgres-meta** (schema API) and
**pg_graphql**, all over one Postgres. Five services, four languages, and a SaaS control
plane. Cloning it inside one Fastify process on one laptop is a product, not a phase.

What is actually worth having, in order of value per unit of work:

| # | Piece | What it gives you | Effort | Needs |
|---|---|---|---|---|
| 7a | **Postgres per project** (the design note) | a real database, linked to an app via `DATABASE_URL` | ~1 checkpoint | named volume, helper-container backups |
| 7b | **Studio-lite**: table browser + SQL editor | see and edit your data without psql; this is the piece you would use daily | ~1–2 checkpoints | `pg` driver in the backend, connect over the app network |
| 7c | **Data API** (PostgREST-lite) | your frontend fetches `https://api.<domain>/rest/<table>` with a per-database key | ~2 checkpoints | a restricted DB role, per-database API key, path/table allowlist |
| 7d | **Realtime** | LISTEN/NOTIFY → WebSocket push to your apps | ~1 checkpoint | nothing new, the WS hub exists |
| — | GoTrue, Storage, Deno functions, pg_graphql | full Supabase parity | months | several services, object storage, a JS runtime |

## What changes in the design already written

- Add the **`pg` driver** to the backend. It buys metrics (size, connections, table list),
  the table browser, the SQL editor and cheap `COPY`-based row export **without** enabling
  `EXEC` and without publishing a port — it connects to `capturehost-db-<id>:5432` on the
  app network, or 127.0.0.1 when the optional port is on.
- Backups stay **helper container** for `pg_dump -Fc`: the driver cannot produce a
  consistent logical dump. No change to the recommendation.
- The SQL editor is an **admin-only surface** (session + CSRF), never published, and every
  statement is audited (statement text truncated, results never logged). It runs as the
  database owner — you own the database, so that is the point.
- 7c is the only piece with a real security design: a per-database API key, a Postgres
  role with no `SUPERUSER`/`CREATEDB`/`CREATEROLE`, table allowlist per key, and no
  reflection of Postgres error text to the caller.

## Recommendation

Ship **7a now** (the phase as specced), then **7b** in the next checkpoint — it is the
"Supabase feeling" for the least risk. Only build **7c** if a real project of yours needs
a browser-callable API; it is the one piece where a mistake means exposing data.
