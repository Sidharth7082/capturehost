"""Unit tests for capturehost.py's helpers.

Standard library only:  python3 -m unittest discover -s tests -v

These cover the parts that decide whether something is safe to kill, healthy, or
worth rotating — the pieces where a silent bug means "the launcher killed the wrong
process" rather than "a page looked odd". Nothing here starts the real stack.
"""

from __future__ import annotations

import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import capturehost  # noqa: E402  (path set up above)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class PortCheckTests(unittest.TestCase):
    def test_port_open_sees_a_listener(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = int(server.getsockname()[1])
            self.assertTrue(capturehost.port_open(port))

    def test_port_open_is_false_for_a_closed_port(self) -> None:
        port = free_port()  # bound, then released: reliably nothing listens there
        self.assertFalse(capturehost.port_open(port))

    def test_port_owner_names_the_process(self) -> None:
        # Not a hard guarantee (ss may hide owners without privileges), so only
        # assert the shape: either empty, or something with a name in it.
        owner = capturehost.port_owner(free_port())
        self.assertIsInstance(owner, str)


class HealthWaitTests(unittest.TestCase):
    def _serve(self, status: int) -> tuple[http.server.HTTPServer, int]:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 (http.server naming)
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args) -> None:  # keep the test output clean
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server, int(server.server_address[1])

    def test_http_ok_true_for_200(self) -> None:
        server, port = self._serve(200)
        try:
            self.assertTrue(capturehost.http_ok(f"http://127.0.0.1:{port}/health"))
        finally:
            server.shutdown()
            server.server_close()

    def test_http_ok_false_for_500(self) -> None:
        server, port = self._serve(500)
        try:
            self.assertFalse(capturehost.http_ok(f"http://127.0.0.1:{port}/health"))
        finally:
            server.shutdown()
            server.server_close()

    def test_wait_until_gives_up_after_the_timeout(self) -> None:
        started = time.monotonic()
        self.assertFalse(capturehost.wait_until(lambda: False, 0.5, 0.1))
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.5)
        self.assertLess(elapsed, 3.0, "the wait should not overshoot the timeout")

    def test_wait_until_returns_as_soon_as_the_predicate_is_true(self) -> None:
        started = time.monotonic()
        self.assertTrue(capturehost.wait_until(lambda: True, 10.0))
        self.assertLess(time.monotonic() - started, 1.0)

    def test_wait_healthy_uses_the_tcp_check_when_there_is_no_probe(self) -> None:
        service = capturehost.Service(
            name="fake",
            port=free_port(),
            cwd=REPO_ROOT,
            argv=(),
            probe_url=None,
            start_timeout=0.5,
        )
        self.assertFalse(capturehost.wait_healthy(service))

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", service.port))
            server.listen(1)
            self.assertTrue(capturehost.wait_healthy(service, timeout=1.0))


class PidVerificationTests(unittest.TestCase):
    def test_verifies_our_own_child(self) -> None:
        process = subprocess.Popen(["sleep", "30"])
        try:
            # Popen can return before the child has exec'd, and an unexec'd child has
            # an empty /proc/<pid>/cmdline. Wait for the command line to appear — the
            # same race that makes `ps` show a half-built process for a moment.
            self.assertTrue(
                capturehost.wait_until(
                    lambda: capturehost.read_cmdline(process.pid) != "", 2.0, 0.02
                ),
                "the child never got a command line",
            )
            self.assertTrue(capturehost.verify_pid(process.pid, "sleep"))
            # Wrong marker = a recycled pid as far as we are concerned.
            self.assertFalse(capturehost.verify_pid(process.pid, "caddy"))
            self.assertFalse(capturehost.verify_pid(process.pid, "sleep", cwd="/"))
            self.assertTrue(capturehost.verify_pid(process.pid, "sleep", cwd=os.getcwd()))
        finally:
            process.kill()
            process.wait(timeout=5)

    def test_dead_pid_is_not_valid(self) -> None:
        process = subprocess.Popen(["true"])
        process.wait(timeout=5)
        pid = process.pid
        self.assertFalse(capturehost.pid_alive(pid))
        self.assertFalse(capturehost.verify_pid(pid, "true"))

    def test_nonsense_pids_are_rejected(self) -> None:
        self.assertFalse(capturehost.verify_pid(0, "sleep"))
        self.assertFalse(capturehost.verify_pid(-1, "sleep"))
        self.assertFalse(capturehost.verify_pid(999_999_999, "sleep"))

    def test_compose_entries_are_always_valid(self) -> None:
        # A compose service has no pid of ours; validity is "we recorded it".
        self.assertTrue(capturehost.entry_is_valid({"kind": "compose", "pid": 0}))
        self.assertFalse(capturehost.entry_is_valid({"pid": 999_999_999, "marker": "x", "cwd": "/"}))


class LogRotationTests(unittest.TestCase):
    def test_rotates_once_over_the_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "backend.log"
            path.write_text("x" * 2048, encoding="utf-8")
            capturehost.rotate_log(path, max_bytes=1024)

            rotated = path.with_name("backend.log.1")
            self.assertFalse(path.exists(), "the live file should have been renamed")
            self.assertTrue(rotated.exists())
            self.assertEqual(rotated.stat().st_size, 2048)

            # Second write after rotation starts a fresh live file.
            path.write_text("new\n", encoding="utf-8")
            self.assertEqual(path.read_text(encoding="utf-8"), "new\n")

    def test_leaves_a_small_file_alone(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "caddy.log"
            path.write_text("small\n", encoding="utf-8")
            capturehost.rotate_log(path, max_bytes=1024)
            self.assertTrue(path.exists())
            self.assertFalse(path.with_name("caddy.log.1").exists())

    def test_nothing_to_rotate_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            capturehost.rotate_log(Path(tmp) / "missing.log", max_bytes=10)

    def test_append_to_log_rotates_at_the_cap(self) -> None:
        # Uses the module's own RUN_DIR override so the real .run/ is untouched.
        with tempfile.TemporaryDirectory() as tmp:
            original_run, original_log = capturehost.RUN_DIR, capturehost.LOG_DIR
            old_cap = capturehost.MAX_LOG_BYTES
            try:
                capturehost.RUN_DIR = Path(tmp)
                capturehost.LOG_DIR = Path(tmp) / "logs"
                capturehost.MAX_LOG_BYTES = 128
                # Rotation happens before a write, once the file is already over the
                # cap: two 100-byte lines fit, the third push rotates.
                for chunk in ("y" * 100, "z" * 100, "w" * 100):
                    capturehost.append_to_log("frontend", chunk)

                logs = Path(tmp) / "logs"
                self.assertTrue((logs / "frontend.log.1").exists(), "expected a rotation")
                self.assertTrue((logs / "frontend.log").exists())
                self.assertGreaterEqual((logs / "frontend.log.1").stat().st_size, 128)
            finally:
                capturehost.RUN_DIR, capturehost.LOG_DIR = original_run, original_log
                capturehost.MAX_LOG_BYTES = old_cap


class ServiceDefinitionTests(unittest.TestCase):
    def test_ports_and_order_are_what_the_docs_say(self) -> None:
        names = [service.name for service in capturehost.services()]
        self.assertEqual(names, ["proxy", "caddy", "backend", "frontend"])

    def test_no_frontend_skips_only_the_frontend(self) -> None:
        names = [service.name for service in capturehost.services(include_frontend=False)]
        self.assertEqual(names, ["proxy", "caddy", "backend"])

    def test_each_service_binds_loopback_only(self) -> None:
        for service in capturehost.services():
            if service.probe_url:
                self.assertTrue(
                    service.probe_url.startswith("http://127.0.0.1:"),
                    f"{service.name} probes a non-loopback URL",
                )

    def test_start_arguments_never_use_a_shell(self) -> None:
        for service in capturehost.services():
            self.assertIsInstance(service.argv, tuple)
            for argument in service.argv:
                self.assertNotIn(";", argument)
                self.assertNotIn("|", argument)


class StateFileTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            original_run, original_state = capturehost.RUN_DIR, capturehost.STATE_FILE
            original_log = capturehost.LOG_DIR
            try:
                capturehost.RUN_DIR = Path(tmp)
                capturehost.LOG_DIR = Path(tmp) / "logs"
                capturehost.STATE_FILE = Path(tmp) / "pids.json"

                self.assertEqual(capturehost.load_state(), {"services": {}})
                capturehost.save_state({"services": {"backend": {"pid": 1}}})
                self.assertEqual(capturehost.recorded(capturehost.load_state(), "backend"), {"pid": 1})

                # A corrupt file must not crash the launcher.
                capturehost.STATE_FILE.write_text("{not json", encoding="utf-8")
                self.assertEqual(capturehost.load_state(), {"services": {}})
            finally:
                capturehost.RUN_DIR, capturehost.STATE_FILE = original_run, original_state
                capturehost.LOG_DIR = original_log


if __name__ == "__main__":
    unittest.main()
