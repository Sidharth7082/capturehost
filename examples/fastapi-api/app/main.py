"""Minimal API for CaptureHost.

Two things matter for the deployment to work, and only the second is obvious:

  1. listen on 0.0.0.0 (the platform's proxy dials the container port, not localhost);
  2. take the port from $PORT so the declared container port can be changed later.
"""

import os

from fastapi import FastAPI

app = FastAPI(title="CaptureHost API example")

PORT = int(os.environ.get("PORT", "8000"))


@app.get("/health")
def health() -> dict[str, str]:
    """Cheap readiness endpoint. Caddy and you both use it."""
    return {"status": "ok"}


@app.get("/api/hello")
def hello(name: str = "world") -> dict[str, object]:
    return {
        "hello": name,
        # Presence only — never echo a connection string.
        "database_linked": bool(os.environ.get("DATABASE_URL")),
        "port": PORT,
    }
