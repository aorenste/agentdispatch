#!/usr/bin/env python3
"""Manage laptop SSH forwards for multi-machine AgentDispatch."""

from __future__ import annotations

import argparse
import curses
import dataclasses
import fcntl
import http.client
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import termios
import time
from pathlib import Path
from typing import Callable, Sequence, TextIO


DEFAULT_REMOTE_PORT = 8915
DEFAULT_LOCAL_PORT = 8915
REMOTE_COMMAND = (
    'if [ ! -x "$HOME/bin/agentdispatch" ]; then '
    'echo "__AGENTDISPATCH_EXIT_STATUS__=127" >&2; '
    'echo "AgentDispatch is not installed at $HOME/bin/agentdispatch" >&2; '
    'exit 127; fi; '
    'data_home="${XDG_DATA_HOME:-$HOME/.local/share}"; '
    'db="$data_home/agentdispatch/agentdispatch.db"; '
    'if ! mkdir -p "$data_home/agentdispatch"; then '
    'echo "__AGENTDISPATCH_EXIT_STATUS__=73" >&2; '
    'echo "Cannot create AgentDispatch data directory: $data_home/agentdispatch" >&2; '
    'exit 73; fi; '
    '"$HOME/bin/agentdispatch" --db "$db"; status=$?; '
    'echo "__AGENTDISPATCH_EXIT_STATUS__=$status" >&2; '
    'exit "$status"'
)
DEFAULT_SSH_COMMAND = "x2ssh -et"
WINDOW_TITLE = "AgentDispatch Port Forwarder"
STATUS_CHECK_INTERVAL = 0.25
READY_STATUS_CHECK_INTERVAL = 5.0
ENDPOINT_TIMEOUT_SECONDS = 0.5
READY_FAILURE_THRESHOLD = 3
MODAL_INPUT_POLL_MS = 50
REMOTE_EXIT_STATUS_RE = re.compile(
    r"^__AGENTDISPATCH_EXIT_STATUS__=(\d+)\r?$", re.MULTILINE
)


@dataclasses.dataclass(frozen=True)
class Connection:
    name: str
    host: str
    local_port: int
    remote_port: int = DEFAULT_REMOTE_PORT
    autostart: bool = True


@dataclasses.dataclass
class Config:
    connections: list[Connection]


BUILTIN_CONNECTIONS = [
    Connection(
        name="devgpu035",
        host="devgpu035.nha1.facebook.com",
        local_port=8915,
    ),
    Connection(
        name="devvm23503",
        host="devvm23503.frc0.facebook.com",
        local_port=8916,
    ),
]

LEGACY_BUILTIN_PORTS = {
    "devgpu035.nha1.facebook.com": (18915, 8915),
    "devvm23503.frc0.facebook.com": (18916, 8916),
}


def default_config_path() -> Path:
    override = os.environ.get("AGENTDISPATCH_CONNECTIONS_FILE")
    if override:
        return Path(override).expanduser()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    return config_home / "agentdispatch" / "connections.json"


def default_state_dir() -> Path:
    override = os.environ.get("AGENTDISPATCH_SSH_STATE_DIR")
    if override:
        return Path(override).expanduser()
    state_home = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
    return state_home / "agentdispatch" / "ssh"


def _connection_from_dict(raw: object, index: int) -> Connection:
    if not isinstance(raw, dict):
        raise ValueError(f"connection {index} must be an object")
    for field in ("name", "host", "local_port"):
        if field not in raw:
            raise ValueError(f"connection {index} is missing {field}")
    try:
        connection = Connection(
            name=str(raw["name"]),
            host=str(raw["host"]),
            local_port=int(raw["local_port"]),
            remote_port=int(raw.get("remote_port", DEFAULT_REMOTE_PORT)),
            autostart=bool(raw.get("autostart", True)),
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"connection {index} has an invalid port") from error
    validate_connection(connection)
    return connection


def load_config(path: Path) -> Config:
    if not path.exists():
        return Config(connections=list(BUILTIN_CONNECTIONS))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {path}: {error}") from error
    if not isinstance(raw, dict) or not isinstance(raw.get("connections"), list):
        raise ValueError(f"{path} must contain a connections list")
    connections: list[Connection] = []
    for index, item in enumerate(raw["connections"], start=1):
        connection = _connection_from_dict(item, index)
        validate_new_connection(connection, connections)
        connections.append(connection)
    return Config(connections=connections)


def save_config(path: Path, config: Config) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    payload = {
        "connections": [dataclasses.asdict(connection) for connection in config.connections]
    }
    try:
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(payload, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def migrate_legacy_builtin_ports(config: Config) -> bool:
    migrated: list[Connection] = []
    changed = False
    for connection in config.connections:
        legacy_and_current = LEGACY_BUILTIN_PORTS.get(connection.host.casefold())
        if legacy_and_current and connection.local_port == legacy_and_current[0]:
            connection = dataclasses.replace(
                connection, local_port=legacy_and_current[1]
            )
            changed = True
        migrated.append(connection)

    ports = [connection.local_port for connection in migrated]
    if len(set(ports)) != len(ports):
        raise ValueError(
            "cannot migrate built-in connections to ports 8915/8916 because "
            "one of those ports is already configured"
        )
    config.connections = migrated
    return changed


def validate_connection(connection: Connection) -> None:
    if not connection.name.strip():
        raise ValueError("connection name cannot be empty")
    if not connection.host.strip():
        raise ValueError("connection host cannot be empty")
    if connection.host.startswith("-") or re.search(r"\s", connection.host):
        raise ValueError("connection host cannot start with '-' or contain whitespace")
    for label, port in (
        ("local port", connection.local_port),
        ("remote port", connection.remote_port),
    ):
        if not 1 <= port <= 65535:
            raise ValueError(f"{label} must be between 1 and 65535")


def validate_new_connection(
    connection: Connection, existing: Sequence[Connection]
) -> None:
    validate_connection(connection)
    if any(item.host.casefold() == connection.host.casefold() for item in existing):
        raise ValueError(f"host {connection.host} is already configured")
    if any(item.local_port == connection.local_port for item in existing):
        raise ValueError(f"local port {connection.local_port} is already configured")


def port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def next_local_port(
    connections: Sequence[Connection],
    start: int = DEFAULT_LOCAL_PORT,
    port_available: Callable[[int], bool] = port_available,
) -> int:
    configured = {connection.local_port for connection in connections}
    for candidate in range(start, 65536):
        if candidate not in configured and port_available(candidate):
            return candidate
    raise ValueError("no local port is available")


def build_ssh_command(
    connection: Connection, ssh_command: Sequence[str]
) -> list[str]:
    if not ssh_command:
        raise ValueError("SSH command cannot be empty")
    if "-et" in ssh_command:
        return [
            *ssh_command,
            connection.host,
            "-t",
            f"{connection.local_port}:{connection.remote_port}",
            "-c",
            REMOTE_COMMAND,
        ]

    forward = (
        f"127.0.0.1:{connection.local_port}:"
        f"127.0.0.1:{connection.remote_port}"
    )
    if Path(ssh_command[0]).name != "x2ssh":
        return [
            *ssh_command,
            "-L",
            forward,
            connection.host,
            REMOTE_COMMAND,
        ]
    return [
        *ssh_command,
        connection.host,
        "-L",
        forward,
        REMOTE_COMMAND,
    ]


def set_terminal_title(
    stream: TextIO, title: str, inside_tmux: bool | None = None
) -> None:
    safe_title = title.replace("\x1b", "").replace("\x07", "")
    osc_sequences = [
        f"\x1b]0;{safe_title}\x07",
        f"\x1b]2;{safe_title}\x07",
    ]
    if inside_tmux is None:
        inside_tmux = bool(os.environ.get("TMUX"))
    if inside_tmux:
        osc_sequences = [
            f"\x1bPtmux;\x1b{sequence}\x1b\\" for sequence in osc_sequences
        ]
    stream.write("".join(osc_sequences))
    stream.flush()


def _safe_log_name(connection: Connection) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", connection.name).strip("._")
    return f"{name or 'connection'}-{connection.local_port}.log"


def endpoint_ready(port: int) -> bool:
    client = http.client.HTTPConnection(
        "127.0.0.1", port, timeout=ENDPOINT_TIMEOUT_SECONDS
    )
    try:
        client.request("GET", "/icon.svg")
        response = client.getresponse()
        return response.status == 200
    except OSError:
        return False
    finally:
        client.close()


@dataclasses.dataclass
class ManagedProcess:
    connection: Connection
    process: subprocess.Popen[bytes]
    log_path: Path
    started_at: float
    cached_status: str = "connecting"
    status_checked_at: float = 0.0
    readiness_failures: int = 0
    terminal_fd: int | None = None
    terminal_output: str = ""


def _make_controlling_terminal() -> None:
    """Start a session whose controlling terminal is Popen's stdin PTY."""
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class ConnectionManager:
    def __init__(
        self,
        ssh_command: Sequence[str],
        state_dir: Path,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self.ssh_command = list(ssh_command)
        self.state_dir = state_dir
        self.popen = popen
        self.processes: dict[str, ManagedProcess] = {}

    def start(self, connection: Connection) -> None:
        current = self.processes.get(connection.host.casefold())
        if current and current.process.poll() is None:
            raise ValueError(f"{connection.name} is already running")
        if not port_available(connection.local_port):
            raise ValueError(
                f"local port {connection.local_port} is already in use; "
                "stop the old/manual forward first"
            )

        self.state_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.state_dir / _safe_log_name(connection)
        command = build_ssh_command(connection, self.ssh_command)
        terminal_fd, child_terminal_fd = os.openpty()
        os.set_blocking(terminal_fd, False)
        with log_path.open("ab", buffering=0) as log:
            log.write(
                f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} starting "
                f"{shlex.join(command)} ---\n".encode()
            )
            try:
                process = self.popen(
                    command,
                    stdin=child_terminal_fd,
                    stdout=child_terminal_fd,
                    stderr=child_terminal_fd,
                    preexec_fn=_make_controlling_terminal,
                )
            except OSError as error:
                os.close(terminal_fd)
                raise ValueError(f"cannot start {self.ssh_command[0]}: {error}") from error
            finally:
                os.close(child_terminal_fd)
        self.processes[connection.host.casefold()] = ManagedProcess(
            connection=connection,
            process=process,
            log_path=log_path,
            started_at=time.monotonic(),
            terminal_fd=terminal_fd,
        )

    def _drain_terminal(self, managed: ManagedProcess) -> None:
        if managed.terminal_fd is None:
            return
        chunks: list[bytes] = []
        while True:
            try:
                chunk = os.read(managed.terminal_fd, 4096)
            except BlockingIOError:
                break
            except OSError:
                break
            if not chunk:
                break
            chunks.append(chunk)
        if not chunks:
            return
        output = b"".join(chunks)
        with managed.log_path.open("ab", buffering=0) as log:
            log.write(output)
        managed.terminal_output = (
            managed.terminal_output + output.decode(errors="replace")
        )[-4096:]

    @staticmethod
    def _close_terminal(managed: ManagedProcess) -> None:
        if managed.terminal_fd is not None:
            try:
                os.close(managed.terminal_fd)
            except OSError:
                pass
            managed.terminal_fd = None

    def terminal_message(self, connection: Connection) -> str:
        output = self.terminal_output(connection)
        plain = re.sub(
            r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))", "", output
        )
        lines = [
            line.strip()
            for line in plain.replace("\r\n", "\n").replace("\r", "\n").splitlines()
            if line.strip()
            and "__AGENTDISPATCH_EXIT_STATUS__=" not in line
        ]
        return lines[-1] if lines else ""

    def terminal_output(self, connection: Connection) -> str:
        managed = self.processes.get(connection.host.casefold())
        if not managed:
            return ""
        self._drain_terminal(managed)
        return managed.terminal_output

    def send_input(self, connection: Connection, data: bytes) -> bool:
        managed = self.processes.get(connection.host.casefold())
        if (
            not managed
            or managed.terminal_fd is None
            or managed.process.poll() is not None
        ):
            return False
        try:
            return os.write(managed.terminal_fd, data) == len(data)
        except OSError:
            return False

    @staticmethod
    def _signal_local_process(
        process: subprocess.Popen[bytes], sig: signal.Signals
    ) -> bool:
        try:
            os.killpg(process.pid, sig)
            return True
        except OSError:
            try:
                if sig == signal.SIGKILL:
                    process.kill()
                else:
                    process.terminate()
                return True
            except OSError:
                return False

    def stop(self, connection: Connection) -> bool:
        key = connection.host.casefold()
        managed = self.processes.get(key)
        if not managed:
            return False
        if managed.process.poll() is not None:
            self._drain_terminal(managed)
            self._close_terminal(managed)
            self.processes.pop(key, None)
            return False

        stopped_gracefully = False
        if managed.terminal_fd is not None:
            try:
                os.write(managed.terminal_fd, b"\x03")
                managed.process.wait(timeout=3)
                stopped_gracefully = True
            except (OSError, subprocess.TimeoutExpired):
                pass
        if not stopped_gracefully and managed.process.poll() is None:
            try:
                self._signal_local_process(managed.process, signal.SIGTERM)
                managed.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._signal_local_process(managed.process, signal.SIGKILL)
                try:
                    managed.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self._drain_terminal(managed)
        self._close_terminal(managed)
        self.processes.pop(key, None)
        return True

    def stop_all(self) -> None:
        for managed in list(self.processes.values()):
            self.stop(managed.connection)

    def status(self, connection: Connection, force: bool = False) -> str:
        managed = self.processes.get(connection.host.casefold())
        if not managed:
            return "stopped"
        self._drain_terminal(managed)
        remote_exit = REMOTE_EXIT_STATUS_RE.search(managed.terminal_output)
        if remote_exit:
            return f"failed ({remote_exit.group(1)})"
        return_code = managed.process.poll()
        if return_code is not None:
            return f"exited ({return_code})"
        now = time.monotonic()
        check_interval = (
            READY_STATUS_CHECK_INTERVAL
            if managed.cached_status == "ready"
            else STATUS_CHECK_INTERVAL
        )
        if force or now - managed.status_checked_at >= check_interval:
            ready = endpoint_ready(connection.local_port)
            if ready:
                managed.cached_status = "ready"
                managed.readiness_failures = 0
            elif managed.cached_status in ("ready", "reconnecting"):
                managed.readiness_failures += 1
                if managed.readiness_failures >= READY_FAILURE_THRESHOLD:
                    managed.cached_status = "reconnecting"
            else:
                managed.cached_status = "connecting"
            managed.status_checked_at = now
        return managed.cached_status

    def log_path(self, connection: Connection) -> Path | None:
        managed = self.processes.get(connection.host.casefold())
        return managed.log_path if managed else None


class SerialConnectionStarter:
    """Start persistent SSH connections one at a time during initial startup."""

    def __init__(
        self,
        connections: Sequence[Connection],
        manager: ConnectionManager,
    ) -> None:
        self.pending = list(connections)
        self.manager = manager
        self.active: Connection | None = None

    def enqueue(self, connection: Connection) -> None:
        self.pending.append(connection)

    def cancel(self, connection: Connection) -> bool:
        key = connection.host.casefold()
        for index, pending in enumerate(self.pending):
            if pending.host.casefold() == key:
                self.pending.pop(index)
                return True
        return False

    def restart(self, connection: Connection) -> None:
        key = connection.host.casefold()
        self.pending = [
            pending
            for pending in self.pending
            if pending.host.casefold() != key
        ]
        self.manager.stop(connection)
        # Put restarts ahead of untouched startup defaults, but never interrupt
        # a different connection that is currently authenticating.
        self.pending.insert(0, connection)

    def advance(self) -> list[str]:
        messages: list[str] = []
        if self.active is not None:
            status = self.manager.status(self.active)
            if status == "connecting":
                return messages
            if status != "ready":
                messages.append(f"{self.active.name}: {status}")
            self.active = None

        while self.active is None and self.pending:
            connection = self.pending.pop(0)
            try:
                self.manager.start(connection)
            except ValueError as error:
                messages.append(f"{connection.name}: {error}")
                continue
            self.active = connection
            messages.append(f"Starting {connection.name}; complete its authentication")

        return messages


def _put(screen: curses.window, row: int, column: int, text: str) -> None:
    height, width = screen.getmaxyx()
    if 0 <= row < height and column < width:
        try:
            screen.addnstr(row, column, text, max(0, width - column - 1))
        except curses.error:
            pass


class Tui:
    def __init__(
        self,
        config: Config,
        config_path: Path,
        manager: ConnectionManager,
        startup_connections: Sequence[Connection],
        startup_messages: Sequence[str],
    ) -> None:
        self.config = config
        self.config_path = config_path
        self.manager = manager
        self.startup = SerialConnectionStarter(startup_connections, manager)
        self.message = "; ".join(startup_messages) or "Connections started"

    def prompt(self, screen: curses.window, label: str, default: str = "") -> str:
        height, width = screen.getmaxyx()
        row = max(0, height - 2)
        screen.timeout(-1)
        curses.echo()
        curses.curs_set(1)
        try:
            screen.move(row, 0)
            screen.clrtoeol()
            prompt = f"{label}" + (f" [{default}]" if default else "") + ": "
            _put(screen, row, 0, prompt)
            screen.refresh()
            value = screen.getstr(row, min(len(prompt), width - 1), max(1, width - len(prompt) - 2))
            decoded = value.decode(errors="replace").strip()
            return decoded or default
        finally:
            curses.noecho()
            curses.curs_set(0)
            screen.timeout(500)

    def add_connection(self, screen: curses.window) -> None:
        host = self.prompt(screen, "SSH host")
        if not host:
            self.message = "Add cancelled"
            return
        name = self.prompt(screen, "Display name", host.split(".")[0])
        suggested_port = next_local_port(self.config.connections)
        raw_port = self.prompt(screen, "Laptop port", str(suggested_port))
        try:
            connection = Connection(name=name, host=host, local_port=int(raw_port))
            validate_new_connection(connection, self.config.connections)
            if not port_available(connection.local_port):
                raise ValueError(f"local port {connection.local_port} is already in use")
            self.config.connections.append(connection)
            save_config(self.config_path, self.config)
            self.startup.enqueue(connection)
            self.message = (
                f"Queued {connection.name} on localhost:{connection.local_port}"
            )
        except ValueError as error:
            self.message = str(error)

    def stop_connection(self, screen: curses.window) -> None:
        if not self.config.connections:
            self.message = "No connections configured"
            return
        raw_index = self.prompt(screen, "Connection number to stop")
        try:
            index = int(raw_index) - 1
            connection = self.config.connections[index]
            if index < 0:
                raise IndexError
        except (ValueError, IndexError):
            self.message = "Invalid connection number"
            return
        if self.startup.cancel(connection):
            self.message = (
                f"Stopped queued {connection.name} (it remains a startup default)"
            )
        elif self.manager.stop(connection):
            self.message = f"Stopped {connection.name} (it remains a startup default)"
        else:
            self.message = f"{connection.name} is not running"

    def restart_connection(self, screen: curses.window) -> None:
        if not self.config.connections:
            self.message = "No connections configured"
            return
        raw_index = self.prompt(screen, "Connection number to restart")
        try:
            index = int(raw_index) - 1
            connection = self.config.connections[index]
            if index < 0:
                raise IndexError
        except (ValueError, IndexError):
            self.message = "Invalid connection number"
            return
        self.startup.restart(connection)
        self.message = f"Restarting {connection.name}"

    def connection_modal(
        self, screen: curses.window, connection: Connection
    ) -> None:
        screen.timeout(MODAL_INPUT_POLL_MS)
        try:
            while True:
                status = self.manager.status(connection)
                if status == "ready":
                    self.message = f"{connection.name} is ready"
                    return
                if status != "connecting":
                    self.message = f"{connection.name}: {status}"
                    return

                output = self.manager.terminal_output(connection)
                plain = re.sub(
                    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))",
                    "",
                    output,
                )
                lines = (
                    plain.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                )
                height, _ = screen.getmaxyx()
                screen.erase()
                _put(screen, 0, 0, f"Connecting to {connection.name}...")
                output_height = max(0, height - 2)
                visible_lines = lines[-output_height:] if output_height else []
                for row, line in enumerate(visible_lines, start=2):
                    _put(screen, row, 0, line)
                screen.refresh()

                key = screen.getch()
                if key == -1:
                    continue
                if key in (curses.KEY_ENTER, 10, 13):
                    data = b"\r"
                elif key in (curses.KEY_BACKSPACE, 8, 127):
                    data = b"\x7f"
                elif 0 <= key <= 255:
                    data = bytes([key])
                else:
                    continue
                if not self.manager.send_input(connection, data):
                    self.message = f"Cannot send input to {connection.name}"
                    return
        finally:
            screen.timeout(500)

    def draw(self, screen: curses.window, force_status: bool = False) -> None:
        screen.erase()
        _put(screen, 0, 0, "AgentDispatch SSH connections")
        _put(screen, 1, 0, f"Config: {self.config_path}")
        _put(screen, 2, 0, "#  Status       Laptop URL              Machine")
        _put(screen, 3, 0, "-  ------------ ----------------------- ------------------------------")
        statuses: list[tuple[Connection, str]] = []
        for index, connection in enumerate(self.config.connections, start=1):
            status = self.manager.status(connection, force=force_status)
            statuses.append((connection, status))
            url = f"http://localhost:{connection.local_port}"
            line = f"{index:<2} {status:<12} {url:<23} {connection.name} ({connection.host})"
            _put(screen, 3 + index, 0, line)
        height, _ = screen.getmaxyx()
        errors = [
            f"{connection.name}: {message}"
            for connection, status in statuses
            if status.startswith(("exited", "failed"))
            and (message := self.manager.terminal_message(connection))
        ]
        if errors:
            error_row = 5 + len(self.config.connections)
            _put(screen, error_row, 0, "Errors:")
            for error in errors:
                error_row += 1
                if error_row >= height - 3:
                    break
                _put(screen, error_row, 0, error)
        if not errors:
            _put(screen, height - 3, 0, self.message)
        _put(
            screen,
            height - 1,
            0,
            "(A)dd  (S)top  (R)estart  (L)ist/refresh  (Q)uit and stop all",
        )
        screen.refresh()

    def run(self, screen: curses.window) -> None:
        curses.curs_set(0)
        screen.keypad(True)
        screen.timeout(500)
        # curses has entered the alternate screen by this point. Setting the
        # title here avoids iTerm2 restoring/overwriting an escape emitted
        # before curses.wrapper initialized the terminal.
        set_terminal_title(sys.stdout, WINDOW_TITLE)
        while True:
            startup_messages = self.startup.advance()
            if startup_messages:
                self.message = "; ".join(startup_messages)
            connecting = next(
                (
                    connection
                    for connection in self.config.connections
                    if self.manager.status(connection) == "connecting"
                ),
                None,
            )
            if connecting is not None:
                self.connection_modal(screen, connecting)
                continue
            self.draw(screen)
            key = screen.getch()
            if key in (ord("a"), ord("A")):
                self.add_connection(screen)
            elif key in (ord("s"), ord("S")):
                self.stop_connection(screen)
            elif key in (ord("r"), ord("R")):
                self.restart_connection(screen)
            elif key in (ord("l"), ord("L")):
                self.message = "Connection status refreshed"
                self.draw(screen, force_status=True)
            elif key in (ord("q"), ord("Q")):
                return


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=default_config_path())
    parser.add_argument(
        "--ssh-command",
        default=os.environ.get("AGENTDISPATCH_SSH_COMMAND", DEFAULT_SSH_COMMAND),
        help=f"SSH command prefix (default: {DEFAULT_SSH_COMMAND!r})",
    )
    parser.add_argument("--list", action="store_true", help="list defaults without starting them")
    parser.add_argument("--no-autostart", action="store_true")
    return parser.parse_args(argv)


def print_connections(config: Config) -> None:
    for connection in config.connections:
        marker = "startup" if connection.autostart else "manual"
        print(
            f"{connection.name}\t{connection.host}\t"
            f"http://localhost:{connection.local_port}\t{marker}"
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    config_path = args.config.expanduser()
    try:
        config_missing = not config_path.exists()
        config = load_config(config_path)
        config_migrated = migrate_legacy_builtin_ports(config)
        if config_missing or config_migrated:
            save_config(config_path, config)
    except ValueError as error:
        print(f"ad-ssh: {error}", file=sys.stderr)
        return 2

    if args.list:
        print_connections(config)
        return 0

    ssh_command = shlex.split(args.ssh_command)
    if not ssh_command:
        print("ad-ssh: --ssh-command cannot be empty", file=sys.stderr)
        return 2
    if shutil.which(ssh_command[0]) is None:
        print(f"ad-ssh: {ssh_command[0]} not found in PATH", file=sys.stderr)
        return 2

    manager = ConnectionManager(ssh_command, default_state_dir())
    startup_connections = (
        []
        if args.no_autostart
        else [connection for connection in config.connections if connection.autostart]
    )
    tui = Tui(config, config_path, manager, startup_connections, [])
    try:
        curses.wrapper(tui.run)
    except KeyboardInterrupt:
        pass
    finally:
        manager.stop_all()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
