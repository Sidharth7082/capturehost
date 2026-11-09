#!/usr/bin/env python3
"""CaptureHost development launcher.

One command for the four things a dev session needs, in the order they need each
other: the Docker socket proxy, Caddy, the backend and the frontend dev server.

    python capturehost.py              # foreground, Ctrl-C stops everything it started
    python capturehost.py start --detach
    python capturehost.py status
    python capturehost.py logs backend -f
    python capturehost.py stop

Design rules, in order of importance:

1. **It only ever stops what it started.** Pids are recorded in .run/pids.json and
   re-verified against /proc (pid, process group, cwd and command line) before any
   signal is sent, because a pid that was recycled during a long session must never
   be killed. Containers other than this compose file's own services are never
   touched, and deployed project containers are left running.
2. **No shell.** Every child is an argument list with an explicit cwd, started in
   its own session (start_new_session) so that npm's grandchildren are in the same
   process group and one SIGTERM reaches all of them.
3. **Nothing privileged.** No sudo, no docker socket, no writes outside .run/.
   When Docker is not running it says how to start it instead of starting it.
4. **Fail loudly, early.** Port checks before each start, health waits with timeouts
   and a message per stage. A port held by someone else stops the run with the
   owning process named from ss — it is not killed.

Python 3 standard library only. Linux (reads /proc), tested on Arch.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent

# .run/ is the only thing this script writes, and it is git-ignored.
RUN_DIR = Path(os.environ.get("CAPTUREHOST_RUN_DIR") or (REPO_ROOT / ".run"))
LOG_DIR = RUN_DIR / "logs"
STATE_FILE = RUN_DIR / "pids.json"

COMPOSE_FILE = REPO_ROOT / "docker-compose.dev.yml"
CADDY_BIN = Path.home() / ".local" / "bin" / "caddy"
CADDY_CONFIG = REPO_ROOT / "deploy" / "caddy" / "Caddyfile"
ENV_FILE = REPO_ROOT / "backend" / ".env"

DASHBOARD_URL = "http://localhost:5173"
CADDY_DASHBOARD_URL = "http://capturehost.localhost:8090"
CADDY_APPS_URL = "http://127.0.0.1:8080"

PROXY_PORT = 2375
CADDY_ADMIN_PORT = 2019
BACKEND_PORT = 8787
FRONTEND_PORT = 5173

# A log file is rotated to <name>.1 once it passes this; one generation is kept,
# which is enough to read "what happened just before it broke".
MAX_LOG_BYTES = 5 * 1024 * 1024

STOP_GRACE_SECONDS = 10.0


# --------------------------------------------------------------------------- #
# service definitions
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Service:
    """Everything the launcher needs to start, probe and identify one service."""

    name: str
    port: int
    cwd: Path
    # For kind='process': the command line. For kind='compose': the container.
    argv: tuple[str, ...]
    kind: str = "process"
    # Substring that must appear in /proc/<pid>/cmdline before we signal it.
    marker: str = ""
    # HTTP probe URL; None means "port open" is the whole health check.
    probe_url: str | None = None
    probe_headers: tuple[tuple[str, str], ...] = ()
    start_timeout: float = 60.0
    color: str = "\033[37m"


def docker_bin() -> str:
    return shutil.which("docker") or "/usr/bin/docker"


def services(include_frontend: bool = True) -> list[Service]:
    found = [
        Service(
            name="proxy",
            kind="compose",
            port=PROXY_PORT,
            cwd=REPO_ROOT,
            argv=(),
            probe_url=f"http://127.0.0.1:{PROXY_PORT}/_ping",
            start_timeout=45.0,
            color="\033[35m",
        ),
        Service(
            name="caddy",
            port=CADDY_ADMIN_PORT,
            cwd=REPO_ROOT,
            argv=(str(CADDY_BIN), "run", "--config", str(CADDY_CONFIG), "--adapter", "caddyfile"),
            marker="caddy",
            # The admin API answers 403 when Origin is missing, so send it.
            probe_url=f"http://127.0.0.1:{CADDY_ADMIN_PORT}/config/",
            probe_headers=(("Origin", f"http://127.0.0.1:{CADDY_ADMIN_PORT}"),),
            start_timeout=25.0,
            color="\033[36m",
        ),
        Service(
            name="backend",
            port=BACKEND_PORT,
            cwd=REPO_ROOT / "backend",
            argv=("npm", "run", "dev"),
            marker="npm",
            probe_url=f"http://127.0.0.1:{BACKEND_PORT}/api/health",
            start_timeout=90.0,
            color="\033[32m",
        ),
    ]
    if include_frontend:
        found.append(
            Service(
                name="frontend",
                port=FRONTEND_PORT,
                cwd=REPO_ROOT / "frontend",
                argv=("npm", "run", "dev"),
                marker="npm",
                probe_url=None,
                start_timeout=90.0,
                color="\033[34m",
            )
        )
    return found


# --------------------------------------------------------------------------- #
# small helpers (unit-tested in tests/test_capturehost_launcher.py)
# --------------------------------------------------------------------------- #


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    """True when something is accepting TCP connections on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def port_owner(port: int) -> str:
    """Who is listening on the port, from ss. Best effort: needs no privileges for
    our own processes and degrades to a blank string when ss hides the owner."""
    ss = shutil.which("ss")
    if not ss:
        return ""
    try:
        out = subprocess.run(
            [ss, "-ltnp", f"sport = :{port}"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""

    for line in out.splitlines():
        if "users:" not in line:
            continue
        owner = line[line.index("users:") + len("users:") :].strip()
        # users:(("node-MainThread",pid=33176,fd=22))
        name = owner.split('"')[1] if owner.count('"') >= 2 else "?"
        pid = ""
        if "pid=" in owner:
            pid = owner.split("pid=")[1].split(",")[0].strip(")")
        return f"{name} (pid {pid})" if pid else name
    return ""


def http_ok(url: str, timeout: float = 2.0, headers: dict[str, str] | None = None) -> bool:
    """GET url and treat 2xx/3xx as healthy. Never raises."""
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 400
    except (urllib.error.URLError, OSError, ValueError):
        return False


def wait_until(predicate, timeout: float, interval: float = 0.3) -> bool:
    """Poll predicate until it is true or the timeout expires."""
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def wait_healthy(service: Service, timeout: float | None = None) -> bool:
    """Health check with a timeout: HTTP probe when there is one, else TCP."""
    limit = timeout if timeout is not None else service.start_timeout
    url = service.probe_url
    if url is not None:
        headers = dict(service.probe_headers)
        return wait_until(lambda: http_ok(url, headers=headers), limit)
    return wait_until(lambda: port_open(service.port), limit)


def healthy(service: Service) -> bool:
    """Instant health check, no waiting."""
    if service.probe_url:
        return http_ok(service.probe_url, headers=dict(service.probe_headers))
    return port_open(service.port)


def read_cmdline(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode("utf-8", "replace").strip()


def read_cwd(pid: int) -> str:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return ""


def pid_alive(pid: int) -> bool:
    return pid > 0 and Path(f"/proc/{pid}").exists()


def verify_pid(pid: int, marker: str, cwd: str | None = None) -> bool:
    """Is this pid still the process we started?

    A three-part check, because any one alone is weak: the pid exists, its command
    line still contains our marker, and (when given) it runs in our directory. A
    recycled pid fails at least one of them on a machine that has been up for days.
    """
    if not pid_alive(pid):
        return False
    cmdline = read_cmdline(pid)
    if not cmdline or marker not in cmdline:
        return False
    if cwd is not None and read_cwd(pid) != os.path.realpath(cwd):
        return False
    return True


def rotate_log(path: Path, max_bytes: int | None = None) -> None:
    """Rotate path to path.1 when it is too big. One generation, no compression.

    `max_bytes` is read at call time (not bound as a default) so tests and any future
    config can change the cap without redefining the function.
    """
    cap = MAX_LOG_BYTES if max_bytes is None else max_bytes
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size < cap:
        return
    rotated = path.with_name(path.name + ".1")
    try:
        if rotated.exists():
            rotated.unlink()
        path.rename(rotated)
    except OSError:
        # A log that cannot be rotated must never stop the stack from starting.
        pass


def ensure_dirs() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def log_path(service_name: str) -> Path:
    return LOG_DIR / f"{service_name}.log"


def append_to_log(service_name: str, text: str) -> None:
    ensure_dirs()
    path = log_path(service_name)
    rotate_log(path)
    with path.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(text)
        if not text.endswith("\n"):
            handle.write("\n")


# --------------------------------------------------------------------------- #
# state file
# --------------------------------------------------------------------------- #


def load_state() -> dict:
    try:
        raw = STATE_FILE.read_text(encoding="utf-8")
    except OSError:
        return {"services": {}}
    try:
        data = json.loads(raw)
    except ValueError:
        return {"services": {}}
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        return {"services": {}}
    return data


def save_state(state: dict) -> None:
    ensure_dirs()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def recorded(state: dict, name: str) -> dict | None:
    entry = state.get("services", {}).get(name)
    return entry if isinstance(entry, dict) else None


def entry_is_valid(entry: dict) -> bool:
    """Compose services have no pid of ours; they are valid while the file says so."""
    if entry.get("kind") == "compose":
        return True
    return verify_pid(int(entry.get("pid", 0)), str(entry.get("marker", "")), entry.get("cwd"))


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #


class Console:
    """Colour when stdout is a terminal, plain text when it is piped to a file."""

    def __init__(self) -> None:
        self.color = sys.stdout.isatty()

    def _paint(self, text: str, color: str) -> str:
        return f"{color}{text}\033[0m" if self.color else text

    def step(self, message: str) -> None:
        print(self._paint(f"==> {message}", "\033[1;37m"), flush=True)

    def ok(self, message: str) -> None:
        print(self._paint(f"    ok   {message}", "\033[32m"), flush=True)

    def skip(self, message: str) -> None:
        print(self._paint(f"    skip {message}", "\033[33m"), flush=True)

    def fail(self, message: str) -> None:
        print(self._paint(f"    fail {message}", "\033[31m"), flush=True)

    def note(self, message: str) -> None:
        print(f"         {message}", flush=True)

    def service_line(self, name: str, color: str, line: str) -> None:
        print(f"{self._paint(f'[{name}]', color)} {line}", flush=True)


# --------------------------------------------------------------------------- #
# preflight
# --------------------------------------------------------------------------- #


def preflight(console: Console, include_frontend: bool) -> bool:
    """Checks that must pass before anything is started. Returns False on failure."""
    console.step("Preflight")

    ok = True
    for tool in ("node", "npm", "docker"):
        if shutil.which(tool) is None:
            console.fail(f"{tool} is not on PATH")
            ok = False
        else:
            console.ok(f"{tool} found at {shutil.which(tool)}")

    if not ok:
        return False

    # Docker daemon: checked, never started (that needs sudo, which this script
    # does not have and does not want).
    try:
        result = subprocess.run(
            [docker_bin(), "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        console.fail(f"could not run docker info: {error}")
        return False

    if result.returncode != 0:
        console.fail("the Docker daemon is not reachable")
        console.note("start it with:  sudo systemctl start docker")
        console.note("(this script never uses sudo)")
        return False
    console.ok(f"Docker daemon reachable (server {result.stdout.strip()})")

    # .env: existence and mode only. Values are never read, printed or copied.
    if not ENV_FILE.is_file():
        console.fail("backend/.env does not exist")
        console.note("create it from the template:  cd backend && cp .env.example .env")
        console.note("then set APP_ENCRYPTION_KEY (openssl rand -base64 32)")
        return False

    mode = ENV_FILE.stat().st_mode & 0o777
    if mode != 0o600:
        console.fail(f"backend/.env has mode {mode:o}, expected 600")
        console.note("fix it with:  chmod 600 backend/.env")
        console.note("(the file is not modified by this script)")
        return False
    console.ok("backend/.env present, mode 600")

    packages = [("backend", REPO_ROOT / "backend")]
    if include_frontend:
        packages.append(("frontend", REPO_ROOT / "frontend"))

    for label, path in packages:
        if (path / "node_modules").is_dir():
            console.ok(f"{label}/node_modules present")
            continue

        console.note(f"{label}/node_modules is missing — installing dependencies (npm install, one time)")
        try:
            install = subprocess.run(["npm", "install"], cwd=str(path), check=False)
        except OSError as error:
            console.fail(f"npm install failed: {error}")
            return False
        if install.returncode != 0:
            console.fail(f"npm install exited {install.returncode} in {label}")
            return False
        console.ok(f"{label}/node_modules installed")

    if not CADDY_BIN.exists():
        console.fail(f"caddy binary not found at {CADDY_BIN}")
        console.note("it is a user-local build, not the pacman package")
        return False
    console.ok(f"caddy binary at {CADDY_BIN}")

    return True


# --------------------------------------------------------------------------- #
# start / stop primitives
# --------------------------------------------------------------------------- #


def compose(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [docker_bin(), "compose", "-f", str(COMPOSE_FILE), *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def proxy_container_state() -> str:
    """'running', 'exited', 'absent' … from docker inspect."""
    try:
        result = subprocess.run(
            [docker_bin(), "inspect", "--format", "{{.State.Status}}", "capturehost-socket-proxy"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return result.stdout.strip() or "absent"


def start_process(service: Service, detach: bool) -> subprocess.Popen:
    """Start one npm/caddy service in its own session.

    Foreground: stdout is a pipe the caller multiplexes. Detached: stdout and
    stderr go straight to the log file, so nothing is lost when this process exits.
    """
    ensure_dirs()
    path = log_path(service.name)
    rotate_log(path)

    if detach:
        handle = path.open("ab")
        return subprocess.Popen(
            list(service.argv),
            cwd=str(service.cwd),
            stdin=subprocess.DEVNULL,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )

    return subprocess.Popen(
        list(service.argv),
        cwd=str(service.cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
        bufsize=0,
    )


def group_alive(pgid: int) -> bool:
    """Is any *live* process still in this process group?

    Zombies do not count. In foreground mode the children are our own, so a
    SIGKILLed child stays visible in /proc as a zombie until it is reaped — and
    `killpg(pgid, 0)` keeps succeeding for it. Without this filter the launcher
    waits its full grace period, sends SIGKILL to something already dead, and then
    reports "would not die" about a process that died immediately.
    """
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fields = stat.rsplit(")", 1)[1].split()
        if len(fields) < 3:
            continue
        state, pgrp = fields[0], fields[2]
        if state == "Z":
            continue
        try:
            if int(pgrp) == pgid:
                return True
        except ValueError:
            continue
    return False


def stop_process(entry: dict, console: Console, name: str, process: subprocess.Popen | None = None) -> bool:
    """SIGTERM the recorded process group, wait, then SIGKILL. Verified first."""
    pid = int(entry.get("pid", 0))
    pgid = int(entry.get("pgid", pid) or pid)
    marker = str(entry.get("marker", ""))
    cwd = entry.get("cwd")

    if not verify_pid(pid, marker, cwd):
        console.skip(f"{name}: pid {pid} is not ours any more, nothing to signal")
        return True

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        console.ok(f"{name}: already gone")
        _reap(process)
        return True
    except PermissionError:
        console.fail(f"{name}: not permitted to signal process group {pgid}")
        return False

    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not group_alive(pgid):
            _reap(process)
            console.ok(f"{name}: stopped")
            return True
        time.sleep(0.1)

    console.note(f"{name}: still alive after {STOP_GRACE_SECONDS:.0f}s — sending SIGKILL")
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if wait_until(lambda: not group_alive(pgid), 5.0):
        _reap(process)
        console.ok(f"{name}: killed")
        return True
    console.fail(f"{name}: process group {pgid} survived SIGKILL")
    return False


def _reap(process: subprocess.Popen | None) -> None:
    """Collect our own child so it does not linger as a zombie."""
    if process is None:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def stop_proxy(console: Console) -> bool:
    """Stop only the services declared in OUR compose file."""
    if proxy_container_state() in ("absent", "exited", "created"):
        console.ok("proxy: not running")
        return True
    result = compose("stop")
    if result.returncode != 0:
        console.fail(f"proxy: docker compose stop failed: {result.stderr.strip()}")
        return False
    console.ok("proxy: stopped (compose stop, this file's services only)")
    return True


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #


class StartupError(Exception):
    """A service could not be started for a reason the launcher already printed.

    Raised instead of exiting inside the loop, so `start_all` can stop what it has
    already started: a port conflict on the backend must not leave Caddy holding
    :2019 with nothing behind it.
    """


def prepare_service(console: Console, service: Service, state: dict) -> tuple[str, dict | None]:
    """Decide what to do with one service before starting it.

    Returns ('skip' | 'start', entry). 'skip' means it is already healthy — either
    ours from an earlier run, or something the user started by hand, which is
    reported and then left alone.
    """
    entry = recorded(state, service.name)

    if service.kind == "compose":
        container = proxy_container_state()
        if container == "running" and healthy(service):
            console.skip(f"proxy: already running and answering on :{service.port}")
            return "skip", None
        if container == "running" and not healthy(service):
            console.note("a proxy container is running but does not answer; restarting it")
            return "start", None
    elif entry is not None and entry_is_valid(entry) and healthy(service):
        console.skip(f"{service.name}: already running (pid {entry['pid']}) and healthy")
        return "skip", None

    if port_open(service.port):
        owner = port_owner(service.port) or "unknown process"
        console.fail(f"{service.name}: port {service.port} is held by {owner}, which this script did not start")
        console.note("stop it yourself, or change the port; nothing was killed")
        raise StartupError(f"port {service.port} busy")

    return "start", entry


def start_all(console: Console, include_frontend: bool, detach: bool) -> int:
    if not preflight(console, include_frontend):
        return 1

    wanted = services(include_frontend)
    console.step("Starting services" + (" in the background" if detach else ""))

    state = load_state()
    started: list[tuple[Service, subprocess.Popen | None]] = []

    if not _bring_up(console, wanted, detach, state, started):
        return 1

    state["include_frontend"] = include_frontend
    save_state(state)
    _print_urls(console, include_frontend, detach)

    if detach:
        return 0

    return _monitor(console, started)


def _bring_up(
    console: Console,
    wanted: list[Service],
    detach: bool,
    state: dict,
    started: list[tuple[Service, subprocess.Popen | None]],
) -> bool:
    """Start every service in order, each only after the previous one is healthy.

    On any failure — including a port held by someone else — everything started so
    far is stopped, so a half-up stack is never left behind.
    """
    try:
        for service in wanted:
            action, _existing = prepare_service(console, service, state)

            if action == "skip":
                continue

            if service.kind == "compose":
                result = compose("up", "-d")
                append_to_log("proxy", result.stdout + result.stderr)
                if result.returncode != 0:
                    console.fail(f"proxy: docker compose up failed: {result.stderr.strip()}")
                    _shutdown(console, started, state)
                    return False
                # Recorded without a pid: `stop` uses compose for this one, and the
                # entry is what tells it "we started it, so we may stop it".
                started.append((service, None))
                state.setdefault("services", {})["proxy"] = {
                    "kind": "compose",
                    "pid": 0,
                    "port": service.port,
                    "cwd": str(REPO_ROOT),
                    "started_at": int(time.time()),
                }
                save_state(state)
            else:
                try:
                    process = start_process(service, detach)
                except OSError as error:
                    console.fail(f"{service.name}: could not start: {error}")
                    _shutdown(console, started, state)
                    return False

                started.append((service, process))
                state.setdefault("services", {})[service.name] = {
                    "pid": process.pid,
                    "pgid": process.pid,  # start_new_session makes it the group leader
                    "cwd": str(service.cwd),
                    "marker": service.marker,
                    "port": service.port,
                    "started_at": int(time.time()),
                }
                save_state(state)

                if not detach:
                    _drain_until_healthy(console, service, process)
                    if process.poll() is not None:
                        console.fail(f"{service.name}: exited during startup (code {process.returncode})")
                        console.note(f"last lines of {log_path(service.name)}")
                        _tail(log_path(service.name), 15, console)
                        _shutdown(console, started, state)
                        return False

            if not wait_healthy(service):
                console.fail(f"{service.name}: not healthy within {service.start_timeout:.0f}s")
                console.note("check the log:  python capturehost.py logs " + service.name)
                _shutdown(console, started, state)
                return False

            console.ok(f"{service.name}: healthy on :{service.port}")

        return True

    except StartupError:
        console.note("start aborted — stopping what was already started")
        _shutdown(console, started, state)
        return False


def _drain_until_healthy(console: Console, service: Service, process: subprocess.Popen) -> None:
    """In foreground mode, echo startup output while the health check runs."""
    if process.stdout is None:
        return
    deadline = time.monotonic() + service.start_timeout
    buffer = b""
    while time.monotonic() < deadline and process.poll() is None:
        if not _read_ready(process.stdout, 0.25):
            if healthy(service):
                return
            continue
        chunk = process.stdout.read(4096)
        if not chunk:
            return
        buffer = _emit_chunk(console, service, buffer, chunk)
        if healthy(service):
            return


def _read_ready(pipe, timeout: float) -> bool:
    selector = selectors.DefaultSelector()
    try:
        selector.register(pipe, selectors.EVENT_READ)
        return bool(selector.select(timeout))
    finally:
        selector.close()


def _emit_chunk(console: Console, service: Service, buffer: bytes, chunk: bytes) -> bytes:
    buffer += chunk
    *lines, buffer = buffer.split(b"\n")
    for raw in lines:
        line = raw.decode("utf-8", "replace").rstrip("\r")
        console.service_line(service.name, service.color, line)
        _tee(service.name, line)
    return buffer


def _tee(service_name: str, line: str) -> None:
    try:
        append_to_log(service_name, line + "\n")
    except OSError:
        pass


def _monitor(console: Console, started: list[tuple[Service, subprocess.Popen | None]]) -> int:
    """Foreground loop: multiplex logs, and stop everything when one service dies."""
    live = [(service, process) for service, process in started if process is not None]
    if not live:
        console.step("Everything was already running; nothing to supervise")
        return 0

    console.step("Running — Ctrl-C stops what this script started")
    selector = selectors.DefaultSelector()
    buffers: dict[str, bytes] = {}
    pipes = {}
    for service, process in live:
        if process.stdout is not None:
            pipes[service.name] = process.stdout
            selector.register(process.stdout, selectors.EVENT_READ, service)
            buffers[service.name] = b""

    try:
        while True:
            for key, _ in selector.select(0.3):
                service = key.data
                pipe = pipes.get(service.name)
                if pipe is None:
                    continue
                chunk = pipe.read(4096)
                if chunk:
                    buffers[service.name] = _emit_chunk(console, service, buffers[service.name], chunk)

            for service, process in live:
                code = process.poll()
                if code is None:
                    continue
                console.fail(f"{service.name} exited with code {code}")
                console.note("stopping the rest")
                state = load_state()
                _shutdown(console, started, state, skip=service.name)
                # The crashed service is gone; forget it so `stop` does not chase it.
                state.get("services", {}).pop(service.name, None)
                save_state(state)
                return 1
    except KeyboardInterrupt:
        console.step("Ctrl-C — stopping what this script started")
        state = load_state()
        _shutdown(console, started, state)
        return 130
    finally:
        selector.close()


def _shutdown(
    console: Console,
    started: list[tuple[Service, subprocess.Popen | None]],
    state: dict,
    skip: str | None = None,
) -> None:
    """Stop every service this launcher owns, in reverse start order.

    Driven by the recorded state rather than by `started`: a service that was
    started by an earlier `capturehost.py` run and skipped by this one (healthy
    already) is still ours, and Ctrl-C should not leave it behind. Anything not in
    the state file was started by someone else and is never touched.
    """
    children = {service.name: process for service, process in started if process is not None}

    for name in ("frontend", "backend", "caddy", "proxy"):
        if skip is not None and name == skip:
            continue
        entry = recorded(state, name)
        if entry is None:
            continue
        if name == "proxy" or entry.get("kind") == "compose":
            stop_proxy(console)
        else:
            stop_process(entry, console, name, children.get(name))
        state.get("services", {}).pop(name, None)
        save_state(state)


def _print_urls(console: Console, include_frontend: bool, detach: bool) -> None:
    console.step("Up")
    if include_frontend:
        console.note(f"dashboard        {DASHBOARD_URL}")
    console.note(f"caddy apps       {CADDY_APPS_URL}  (deployed projects, via Caddy)")
    console.note(f"caddy dashboard  {CADDY_DASHBOARD_URL}  (Caddyfile site)")
    console.note(f"logs             {LOG_DIR}/<service>.log")
    if detach:
        console.note("background     python capturehost.py status | logs backend -f | stop")


def command_stop(console: Console) -> int:
    state = load_state()
    entries = state.get("services", {})
    if not entries:
        console.step("Nothing recorded as started by this script")

    console.step("Stopping what this script started")
    failures = 0
    for name in ("frontend", "backend", "caddy", "proxy"):
        entry = entries.get(name)
        if name == "proxy":
            # Only if we recorded it; a proxy started by hand stays up.
            if entry is None:
                console.skip("proxy: not started by this script, left running")
                continue
            if not stop_proxy(console):
                failures += 1
            entries.pop(name, None)
            save_state(state)
            continue
        if entry is None:
            continue
        if stop_process(entry, console, name):
            entries.pop(name, None)
        else:
            failures += 1
        save_state(state)

    console.step("Stopped" if failures == 0 else "Stopped with errors")
    return 0 if failures == 0 else 1


def command_status(console: Console) -> int:
    state = load_state()
    wanted = services(include_frontend=True)

    rows = []
    for service in wanted:
        entry = recorded(state, service.name)
        if entry is not None and not entry_is_valid(entry):
            entry = None  # stale record: the pid is gone or was recycled
            state.get("services", {}).pop(service.name, None)

        if service.kind == "compose":
            container = proxy_container_state()
            if container == "running" and healthy(service):
                rows.append(("proxy", "running", "-", service.port, "ok"))
            elif container == "running":
                rows.append(("proxy", "running", "-", service.port, "no answer"))
            elif entry is not None:
                rows.append(("proxy", "recorded", "-", service.port, "not running"))
            elif port_open(service.port):
                rows.append(("proxy", "foreign", port_owner(service.port) or "?", service.port, "not ours"))
            else:
                rows.append(("proxy", "stopped", "-", service.port, "-"))
            continue

        if entry is not None:
            state_text = "running"
            pid = entry["pid"]
        elif port_open(service.port):
            # Something is listening, but it is not ours: say so instead of "stopped".
            state_text = "foreign"
            pid = port_owner(service.port) or "?"
        else:
            state_text = "stopped"
            pid = "-"

        health = "ok" if healthy(service) else ("no answer" if state_text != "stopped" else "-")
        rows.append((service.name, state_text, pid, service.port, health))

    save_state(state)

    headers = ("SERVICE", "STATE", "PID", "PORT", "HEALTH")
    widths = [max(len(str(row[i])) for row in [headers, *rows]) for i in range(len(headers))]
    print("  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(cell).ljust(w) for cell, w in zip(row, widths)))
    return 0


def command_logs(console: Console, name: str, follow: bool) -> int:
    names = [service.name for service in services(include_frontend=True)]
    if name not in names:
        console.fail(f"unknown service '{name}' — one of: {', '.join(names)}")
        return 2

    path = log_path(name)
    if not path.exists():
        console.fail(f"no log yet at {path}")
        return 1

    _tail(path, 40, console)
    if not follow:
        return 0

    console.note(f"following {path} — Ctrl-C to stop following (services keep running)")
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            handle.seek(0, os.SEEK_END)
            while True:
                line = handle.readline()
                if line:
                    console.service_line(name, "\033[37m", line.rstrip("\n"))
                else:
                    time.sleep(0.4)
    except KeyboardInterrupt:
        return 0


def _tail(path: Path, lines: int, console: Console) -> None:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    for line in content[-lines:]:
        console.note(line)


def command_doctor(console: Console) -> int:
    console.step("npm run doctor (backend/)")
    return subprocess.run(["npm", "run", "doctor"], cwd=str(REPO_ROOT / "backend"), check=False).returncode


def command_open(console: Console) -> int:
    console.step(f"Opening {DASHBOARD_URL}")
    console.note("if the page does not load, check: python capturehost.py status")
    return 0 if webbrowser.open(DASHBOARD_URL) else 1


def command_prod_hint(console: Console) -> int:
    console.step("--prod is not a mode of this script")
    console.note("production runs under systemd from /opt/capturehost, not from a checkout:")
    console.note("    sudo systemctl start capturehost")
    console.note(f"the full sequence is in {REPO_ROOT / 'deploy' / 'README.md'}")
    return 0


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="capturehost.py",
        description="Start, stop and watch the CaptureHost development stack.",
        epilog="Production is not this script: it runs under systemd (see deploy/README.md).",
    )

    def add_start_flags(target: argparse.ArgumentParser, *, suppress_default: bool = False) -> None:
        default = argparse.SUPPRESS if suppress_default else False
        target.add_argument("--detach", "-d", action="store_true", default=default, help="run in the background and return")
        target.add_argument("--no-frontend", action="store_true", default=default, help="backend and Caddy only")
        target.add_argument("--prod", action="store_true", default=default, help="explain that production uses systemd")

    # Bare `python capturehost.py` means start, so the flags live here too.
    add_start_flags(parser)

    sub = parser.add_subparsers(dest="command")

    start = sub.add_parser("start", help="start everything (foreground unless --detach)")
    add_start_flags(start, suppress_default=True)

    sub.add_parser("stop", help="stop what this script started")

    restart = sub.add_parser("restart", help="stop, then start in the foreground")
    add_start_flags(restart, suppress_default=True)

    sub.add_parser("status", help="table of service, state, pid, port and health")

    logs = sub.add_parser("logs", help="print (and optionally follow) a service log")
    logs.add_argument("service")
    logs.add_argument("-f", "--follow", action="store_true")

    sub.add_parser("setup", help="prepare a fresh clone: config, keys, dependencies")
    sub.add_parser("doctor", help="run the backend ops doctor")
    sub.add_parser("open", help="open the dashboard in a browser")

    return parser


# --------------------------------------------------------------------- setup


def _b64_key() -> str:
    """A 32-byte key, base64-encoded — the shape the backend's config expects."""
    import base64

    return base64.b64encode(os.urandom(32)).decode("ascii")


def _tool_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    first = (result.stdout or result.stderr or "").strip().splitlines()
    return first[0].strip() if first else None


def _write_dotenv(env_example: Path, env_path: Path) -> tuple[bool, list[str]]:
    """
    Create backend/.env from the example, filling in the two encryption keys.

    Returns (created, generated_keys). An existing .env is never touched: it may hold
    keys that already encrypt stored credentials, and replacing it would orphan them.
    """
    if env_path.exists():
        return False, []

    text = env_example.read_text(encoding="utf-8")
    generated: list[str] = []

    for key in ("APP_ENCRYPTION_KEY", "BACKUP_ENCRYPTION_KEY"):
        value = _b64_key()
        text = re.sub(rf"^{key}=.*$", f"{key}={value}", text, count=1, flags=re.MULTILINE)
        generated.append(key)

    env_path.write_text(text, encoding="utf-8")
    env_path.chmod(0o600)  # it holds encryption keys; nobody else on the host needs it
    return True, generated


def command_setup(console: Console) -> int:
    """Everything a fresh clone needs, in one command."""
    console.step("Checking what this machine already has")
    problems: list[str] = []

    python_ok = sys.version_info >= (3, 10)
    console.ok(f"python {sys.version.split()[0]}") if python_ok else console.fail("python 3.10 or newer is required")

    node = _tool_version(["node", "--version"])
    if node:
        console.ok(f"node {node}")
    else:
        console.fail("node is missing — install Node.js 20 or newer")
        problems.append("node")

    npm = _tool_version(["npm", "--version"])
    if npm:
        console.ok(f"npm {npm}")
    else:
        console.fail("npm is missing — it ships with Node.js")
        problems.append("npm")

    docker = _tool_version([docker_bin(), "--version"])
    if docker:
        console.ok(docker)
        reachable = subprocess.run(
            [docker_bin(), "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if reachable.returncode == 0:
            console.ok(f"docker daemon reachable ({reachable.stdout.strip()})")
        else:
            console.fail("the docker daemon is not reachable — start Docker and add yourself to the docker group")
            problems.append("docker-daemon")
    else:
        console.fail("docker is missing — CaptureHost runs every deployed app in a container")
        problems.append("docker")

    if _tool_version(["git", "--version"]):
        console.ok(_tool_version(["git", "--version"]) or "git")
    else:
        console.fail("git is missing — deployments clone repositories")
        problems.append("git")

    # ---- configuration ----
    console.step("Configuration")
    env_example = ENV_FILE.with_name(".env.example")
    env_path = ENV_FILE

    if not env_example.exists():
        console.fail(f"{env_example} is missing — is this a complete clone?")
        return 1

    created, generated = _write_dotenv(env_example, env_path)
    if created:
        console.ok(f"wrote {env_path} (mode 600) with {', '.join(generated)}")
        console.note("Keep a copy of BACKUP_ENCRYPTION_KEY somewhere off this machine: without it, encrypted backups cannot be opened.")
    else:
        console.skip(f"{env_path} already exists — left untouched")

    try:
        text = env_path.read_text(encoding="utf-8")
        secret = re.search(r"^APP_ENCRYPTION_KEY=(.*)$", text, flags=re.MULTILINE)
        if not secret or not secret.group(1).strip():
            console.fail("APP_ENCRYPTION_KEY is empty — generate one with: openssl rand -base64 32")
            problems.append("APP_ENCRYPTION_KEY")
        else:
            console.ok("APP_ENCRYPTION_KEY is set")
    except OSError:
        console.fail(f"cannot read {env_path}")

    ensure_dirs()

    # ---- dependencies ----
    console.step("Installing dependencies (once, a few minutes)")
    for label, directory in (("backend", REPO_ROOT / "backend"), ("frontend", REPO_ROOT / "frontend")):
        if (directory / "node_modules").is_dir():
            console.skip(f"{label}/node_modules present")
            continue
        console.note(f"installing {label} dependencies")
        installed = False
        for command in (["npm", "ci"], ["npm", "install"]):
            result = subprocess.run(command, cwd=directory, capture_output=True, text=True, check=False)
            if result.returncode == 0:
                console.ok(f"{label}/node_modules installed")
                installed = True
                break
        if not installed:
            console.fail(f"npm install failed in {label}/ — run it by hand to see the error")
            problems.append(f"{label}-deps")

    # ---- verdict ----
    print()
    if problems:
        console.fail(f"setup is incomplete: {', '.join(problems)}")
        console.note("Fix those, then run this again — it is safe to repeat.")
        return 1

    console.ok("setup complete")
    console.note("")
    console.note("Next:")
    console.note("  python3 capturehost.py start")
    console.note("  open http://localhost:5173 and create the admin account (first run only)")
    console.note("  python3 capturehost.py doctor   # what is healthy, what is not")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    console = Console()

    if args.prod:
        return command_prod_hint(console)

    command = args.command or "start"

    if command == "start":
        return start_all(console, not args.no_frontend, args.detach)

    if command == "restart":
        code = command_stop(console)
        if code != 0:
            return code
        return start_all(console, not args.no_frontend, args.detach)

    if command == "stop":
        return command_stop(console)

    if command == "status":
        return command_status(console)

    if command == "logs":
        return command_logs(console, args.service, args.follow)

    if command == "setup":
        return command_setup(console)

    if command == "doctor":
        return command_doctor(console)

    if command == "open":
        return command_open(console)

    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
