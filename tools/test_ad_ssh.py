import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("ad-ssh.py")
SPEC = importlib.util.spec_from_file_location("ad_ssh", MODULE_PATH)
ad_ssh = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ad_ssh
SPEC.loader.exec_module(ad_ssh)


class ConnectionConfigTests(unittest.TestCase):
    def test_missing_config_uses_the_two_initial_machines(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = ad_ssh.load_config(Path(tmp) / "connections.json")

        self.assertEqual(
            [(c.host, c.local_port) for c in config.connections],
            [
                ("devgpu035.nha1.facebook.com", 8915),
                ("devvm23503.frc0.facebook.com", 8916),
            ],
        )
        self.assertTrue(all(c.autostart for c in config.connections))

    def test_migrates_legacy_ports_for_the_two_builtin_hosts(self):
        config = ad_ssh.Config(
            [
                ad_ssh.Connection(
                    "devgpu035", "devgpu035.nha1.facebook.com", 18915
                ),
                ad_ssh.Connection(
                    "devvm23503", "devvm23503.frc0.facebook.com", 18916
                ),
            ]
        )

        self.assertTrue(ad_ssh.migrate_legacy_builtin_ports(config))
        self.assertEqual([connection.local_port for connection in config.connections], [8915, 8916])

    def test_config_round_trip_is_atomic_and_preserves_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "connections.json"
            expected = ad_ssh.Config(
                connections=[
                    ad_ssh.Connection(
                        name="gpu",
                        host="gpu.example.com",
                        local_port=19001,
                        remote_port=9000,
                        autostart=False,
                    )
                ]
            )
            ad_ssh.save_config(path, expected)
            actual = ad_ssh.load_config(path)

        self.assertEqual(actual, expected)

    def test_invalid_config_reports_the_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "connections.json"
            path.write_text(json.dumps({"connections": [{"name": "bad"}]}))
            with self.assertRaisesRegex(ValueError, "host"):
                ad_ssh.load_config(path)


class CommandTests(unittest.TestCase):
    expected_remote_command = (
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

    def test_sets_the_port_forwarder_window_title(self):
        output = io.StringIO()
        ad_ssh.set_terminal_title(
            output, "AgentDispatch Port Forwarder", inside_tmux=False
        )
        self.assertEqual(
            output.getvalue(),
            "\x1b]0;AgentDispatch Port Forwarder\x07"
            "\x1b]2;AgentDispatch Port Forwarder\x07",
        )

    def test_wraps_the_window_title_for_tmux_passthrough(self):
        output = io.StringIO()
        ad_ssh.set_terminal_title(
            output, "AgentDispatch Port Forwarder", inside_tmux=True
        )
        self.assertEqual(
            output.getvalue(),
            "\x1bPtmux;\x1b\x1b]0;AgentDispatch Port Forwarder\x07\x1b\\"
            "\x1bPtmux;\x1b\x1b]2;AgentDispatch Port Forwarder\x07\x1b\\",
        )

    def test_builds_reconnecting_et_forward_and_remote_command(self):
        connection = ad_ssh.Connection(
            name="vm",
            host="devvm23503.frc0.facebook.com",
            local_port=8916,
        )
        command = ad_ssh.build_ssh_command(connection, ["x2ssh", "-et"])

        self.assertEqual(
            command,
            [
                "x2ssh",
                "-et",
                "devvm23503.frc0.facebook.com",
                "-t",
                "8916:8915",
                "-c",
                self.expected_remote_command,
            ],
        )

    def test_builds_standard_ssh_forward_when_et_is_not_selected(self):
        connection = ad_ssh.Connection("vm", "vm.example.com", 19000)

        self.assertEqual(
            ad_ssh.build_ssh_command(connection, ["ssh"]),
            [
                "ssh",
                "-L",
                "127.0.0.1:19000:127.0.0.1:8915",
                "vm.example.com",
                self.expected_remote_command,
            ],
        )

    def test_next_port_skips_configured_and_currently_bound_ports(self):
        connections = [
            ad_ssh.Connection("a", "a.example.com", 18915),
            ad_ssh.Connection("b", "b.example.com", 18917),
        ]
        self.assertEqual(
            ad_ssh.next_local_port(
                connections,
                start=18915,
                port_available=lambda port: port != 18916,
            ),
            18918,
        )

    def test_duplicate_host_or_port_is_rejected(self):
        existing = [ad_ssh.Connection("a", "a.example.com", 18915)]
        with self.assertRaisesRegex(ValueError, "host"):
            ad_ssh.validate_new_connection(
                ad_ssh.Connection("again", "a.example.com", 18916), existing
            )
        with self.assertRaisesRegex(ValueError, "port"):
            ad_ssh.validate_new_connection(
                ad_ssh.Connection("other", "b.example.com", 18915), existing
            )

    def test_readiness_does_not_download_the_workspace_payload(self):
        client = mock.Mock()
        response = mock.Mock(status=200)
        response.read.side_effect = TimeoutError("large response was too slow")
        client.getresponse.return_value = response

        with mock.patch.object(
            ad_ssh.http.client, "HTTPConnection", return_value=client
        ) as connection:
            self.assertTrue(ad_ssh.endpoint_ready(8915))

        connection.assert_called_once_with("127.0.0.1", 8915, timeout=0.5)
        client.request.assert_called_once_with("GET", "/icon.svg")
        response.read.assert_not_called()


class FakeProcess:
    def __init__(self):
        self.pid = 12345
        self.return_code = None

    def poll(self):
        return self.return_code

    def wait(self, timeout):
        self.return_code = 0
        return 0


class ManagerTests(unittest.TestCase):
    def test_ready_connection_is_not_probed_four_times_per_second(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=FakeProcess(),
            log_path=Path("/tmp/a.log"),
            started_at=0,
            cached_status="ready",
            status_checked_at=0,
        )

        with mock.patch.object(ad_ssh.time, "monotonic", return_value=1.0), \
             mock.patch.object(ad_ssh, "endpoint_ready") as endpoint_ready:
            self.assertEqual(manager.status(connection), "ready")

        endpoint_ready.assert_not_called()

    def test_ready_connection_becomes_reconnecting_without_returning_to_startup(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
            cached_status="ready",
            status_checked_at=0,
        )

        with mock.patch.object(
            ad_ssh.time, "monotonic", side_effect=[1.0, 2.0, 3.0, 4.0]
        ), mock.patch.object(ad_ssh, "endpoint_ready", return_value=False):
            self.assertEqual(manager.status(connection, force=True), "ready")
            self.assertEqual(manager.status(connection, force=True), "ready")
            self.assertEqual(manager.status(connection, force=True), "reconnecting")
            self.assertEqual(manager.status(connection, force=True), "reconnecting")

    def test_stop_falls_back_when_process_group_signal_is_not_permitted(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = mock.Mock()
        process.pid = 12345
        process.poll.return_value = None
        process.wait.return_value = 0
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
        )

        with mock.patch.object(
            ad_ssh.os, "killpg", side_effect=PermissionError(1, "not permitted")
        ):
            self.assertTrue(manager.stop(connection))

        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=3)

    def test_stop_interrupts_remote_command_before_terminating_transport(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
            terminal_fd=123,
        )

        with mock.patch.object(ad_ssh.os, "write", return_value=1) as write, \
             mock.patch.object(ad_ssh.os, "killpg") as killpg, \
             mock.patch.object(ad_ssh.os, "close"):
            self.assertTrue(manager.stop(connection))

        write.assert_called_once_with(123, b"\x03")
        killpg.assert_not_called()

    def test_remote_server_exit_is_failure_even_while_et_is_still_running(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
            terminal_output=(
                'echo "__AGENTDISPATCH_EXIT_STATUS__=127"\r\n'
                "agentdispatch: cannot bind 127.0.0.1:8915\r\n"
                "__AGENTDISPATCH_EXIT_STATUS__=1\r\n"
                'if [ ! -x "$HOME/bin/agentdispatch" ]; then '
                'echo "__AGENTDISPATCH_EXIT_STATUS__=127"; fi\r\n'
            ),
        )

        self.assertEqual(manager.status(connection), "failed (1)")
        self.assertEqual(
            manager.terminal_message(connection),
            "agentdispatch: cannot bind 127.0.0.1:8915",
        )

    def test_status_rechecks_readiness_without_a_two_second_lag(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
            cached_status="connecting",
            status_checked_at=10.0,
        )

        with mock.patch.object(ad_ssh.time, "monotonic", return_value=10.3), \
             mock.patch.object(ad_ssh, "endpoint_ready", return_value=True):
            self.assertEqual(manager.status(connection), "ready")

    def test_sends_authentication_input_to_the_connection_terminal(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
            terminal_fd=123,
        )

        with mock.patch.object(ad_ssh.os, "write", return_value=4) as write:
            self.assertTrue(manager.send_input(connection, b"123\r"))

        write.assert_called_once_with(123, b"123\r")

    def test_start_gives_ssh_a_pseudoterminal_for_interactive_authentication(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        popen = mock.Mock(return_value=process)

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(ad_ssh, "port_available", return_value=True), \
             mock.patch.object(ad_ssh.os, "openpty", return_value=(100, 101)), \
             mock.patch.object(ad_ssh.os, "set_blocking"), \
             mock.patch.object(ad_ssh.os, "close"):
            manager = ad_ssh.ConnectionManager(
                ["x2ssh", "-et"], Path(tmp), popen=popen
            )
            manager.start(connection)

        launch = popen.call_args.kwargs
        self.assertEqual(launch["stdin"], 101)
        self.assertEqual(launch["stdout"], 101)
        self.assertEqual(launch["stderr"], 101)
        self.assertEqual(
            manager.processes[connection.host.casefold()].terminal_fd, 100
        )

    def test_stopped_connection_is_reported_as_stopped(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)
        process = FakeProcess()
        manager = ad_ssh.ConnectionManager(["x2ssh", "-et"], Path("/tmp"))
        manager.processes[connection.host.casefold()] = ad_ssh.ManagedProcess(
            connection=connection,
            process=process,
            log_path=Path("/tmp/a.log"),
            started_at=0,
        )

        with mock.patch.object(ad_ssh.os, "killpg"):
            self.assertTrue(manager.stop(connection))

        self.assertEqual(manager.status(connection), "stopped")


class SerialStartupTests(unittest.TestCase):
    def test_waits_for_each_connection_before_starting_the_next(self):
        first = ad_ssh.Connection("a", "a.example.com", 18915)
        second = ad_ssh.Connection("b", "b.example.com", 18916)
        added = ad_ssh.Connection("c", "c.example.com", 18917)

        class FakeManager:
            def __init__(self):
                self.started = []
                self.statuses = {}

            def start(self, connection):
                self.started.append(connection)
                self.statuses[connection.host] = "connecting"

            def status(self, connection):
                return self.statuses[connection.host]

        manager = FakeManager()
        startup = ad_ssh.SerialConnectionStarter([first, second], manager)

        startup.advance()
        startup.advance()
        startup.enqueue(added)
        startup.advance()
        self.assertEqual(manager.started, [first])

        manager.statuses[first.host] = "ready"
        startup.advance()
        self.assertEqual(manager.started, [first, second])

        self.assertTrue(startup.cancel(added))
        manager.statuses[second.host] = "ready"
        startup.advance()
        self.assertEqual(manager.started, [first, second])

    def test_restart_stops_connection_and_queues_it_next(self):
        target = ad_ssh.Connection("a", "a.example.com", 18915)
        authenticating = ad_ssh.Connection("b", "b.example.com", 18916)
        later = ad_ssh.Connection("c", "c.example.com", 18917)

        class FakeManager:
            def __init__(self):
                self.started = []
                self.stopped = []
                self.statuses = {authenticating.host: "connecting"}

            def start(self, connection):
                self.started.append(connection)
                self.statuses[connection.host] = "connecting"

            def stop(self, connection):
                self.stopped.append(connection)
                self.statuses[connection.host] = "stopped"
                return True

            def status(self, connection):
                return self.statuses[connection.host]

        manager = FakeManager()
        startup = ad_ssh.SerialConnectionStarter([later, target], manager)
        startup.active = authenticating

        startup.restart(target)

        self.assertEqual(manager.stopped, [target])
        self.assertEqual(startup.pending, [target, later])
        manager.statuses[authenticating.host] = "ready"
        startup.advance()
        self.assertEqual(manager.started, [target])


class ConnectionModalTests(unittest.TestCase):
    def test_remote_failure_closes_connection_modal(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)

        class FakeManager:
            def status(self, _connection):
                return "failed (127)"

        class FakeScreen:
            def timeout(self, _milliseconds):
                pass

            def getch(self):
                raise AssertionError("failed modal must not wait for input")

        tui = ad_ssh.Tui(
            ad_ssh.Config([connection]),
            Path("/tmp/connections.json"),
            FakeManager(),
            [],
            [],
        )

        tui.connection_modal(FakeScreen(), connection)

        self.assertEqual(tui.message, "a: failed (127)")

    def test_crlf_terminal_output_is_rendered_as_single_newlines(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)

        class FakeManager:
            finished = False

            def status(self, _connection):
                return "exited (1)" if self.finished else "connecting"

            def terminal_output(self, _connection):
                return "first\r\nsecond\r\n"

            def send_input(self, _connection, _data):
                self.finished = True
                return True

        class FakeScreen:
            def __init__(self):
                self.writes = []

            def timeout(self, _milliseconds):
                pass

            def erase(self):
                pass

            def getmaxyx(self):
                return (24, 80)

            def addnstr(self, *args):
                self.writes.append(args)

            def refresh(self):
                pass

            def getch(self):
                return ord("x")

        manager = FakeManager()
        screen = FakeScreen()
        tui = ad_ssh.Tui(
            ad_ssh.Config([connection]),
            Path("/tmp/connections.json"),
            manager,
            [],
            [],
        )

        tui.connection_modal(screen, connection)

        rows = [(row, text) for row, _column, text, _limit in screen.writes]
        self.assertIn((2, "first"), rows)
        self.assertIn((3, "second"), rows)

    def test_run_automatically_opens_modal_while_connecting(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)

        class FakeManager:
            status_value = "connecting"

            def status(self, _connection):
                return self.status_value

        class FakeScreen:
            def keypad(self, _enabled):
                pass

            def timeout(self, _milliseconds):
                pass

            def getch(self):
                return ord("q")

        manager = FakeManager()
        tui = ad_ssh.Tui(
            ad_ssh.Config([connection]),
            Path("/tmp/connections.json"),
            manager,
            [],
            [],
        )
        tui.startup.advance = mock.Mock(return_value=[])
        tui.draw = mock.Mock()

        def finish_connection(_screen, _connection):
            manager.status_value = "ready"

        tui.connection_modal = mock.Mock(side_effect=finish_connection)
        with mock.patch.object(ad_ssh.curses, "curs_set"), \
             mock.patch.object(ad_ssh, "set_terminal_title"):
            tui.run(FakeScreen())

        tui.connection_modal.assert_called_once_with(mock.ANY, connection)

    def test_q_is_forwarded_to_connecting_terminal_instead_of_quitting(self):
        connection = ad_ssh.Connection("a", "a.example.com", 18915)

        class FakeManager:
            def __init__(self):
                self.sent = []
                self.finished = False

            def status(self, _connection):
                return "exited (1)" if self.finished else "connecting"

            def terminal_output(self, _connection):
                return "Passcode: "

            def send_input(self, _connection, data):
                self.sent.append(data)
                self.finished = True
                return True

        class FakeScreen:
            def __init__(self):
                self.erased = 0
                self.writes = []

            def timeout(self, _milliseconds):
                pass

            def erase(self):
                self.erased += 1

            def getmaxyx(self):
                return (24, 80)

            def addnstr(self, *args):
                self.writes.append(args)

            def refresh(self):
                pass

            def getch(self):
                return ord("q")

        manager = FakeManager()
        screen = FakeScreen()
        tui = ad_ssh.Tui(
            ad_ssh.Config([connection]),
            Path("/tmp/connections.json"),
            manager,
            [],
            [],
        )

        tui.connection_modal(screen, connection)

        self.assertEqual(manager.sent, [b"q"])
        self.assertGreater(screen.erased, 0)
        self.assertTrue(
            any(row == 0 and text == "Connecting to a..." for row, _column, text, _limit in screen.writes)
        )


class ErrorDisplayTests(unittest.TestCase):
    def test_lists_the_error_for_every_failed_connection(self):
        first = ad_ssh.Connection("a", "a.example.com", 18915)
        second = ad_ssh.Connection("b", "b.example.com", 18916)

        class FakeManager:
            def status(self, connection, force=False):
                return "failed (1)" if connection == first else "failed (127)"

            def terminal_message(self, connection):
                return "address already in use" if connection == first else "not installed"

        class FakeScreen:
            def __init__(self):
                self.writes = []

            def erase(self):
                pass

            def getmaxyx(self):
                return (24, 100)

            def addnstr(self, *args):
                self.writes.append(args)

            def refresh(self):
                pass

        screen = FakeScreen()
        tui = ad_ssh.Tui(
            ad_ssh.Config([first, second]),
            Path("/tmp/connections.json"),
            FakeManager(),
            [],
            [],
        )
        tui.message = "b: failed (127)"

        tui.draw(screen)

        rendered = [text for _row, _column, text, _limit in screen.writes]
        self.assertIn("a: address already in use", rendered)
        self.assertIn("b: not installed", rendered)
        self.assertNotIn("b: failed (127)", rendered)
        self.assertTrue(any("(R)estart" in text for text in rendered))


if __name__ == "__main__":
    unittest.main()
