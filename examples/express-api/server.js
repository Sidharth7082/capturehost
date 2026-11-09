import express from 'express';

/**
 * Minimal API for CaptureHost.
 *
 * The two rules that make it deployable:
 *   1. bind 0.0.0.0 — the platform's proxy dials the container port, and localhost
 *      inside a container is only the container;
 *   2. listen on $PORT, defaulting to the port you declare in the project.
 */
const app = express();
const port = Number(process.env.PORT ?? 8080);

app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/hello', (request, response) => {
  response.json({
    hello: String(request.query.name ?? 'world'),
    // Presence only — never echo a connection string.
    databaseLinked: Boolean(process.env.DATABASE_URL),
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`listening on 0.0.0.0:${port}`);
});
