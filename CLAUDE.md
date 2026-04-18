# AgentDispatch project conventions

## Bug fixing workflow

**EXTREMELY IMPORTANT: ALWAYS write a failing test FIRST, then fix the bug.** Do
not fix the bug before you have a test that reproduces it. Verify the test fails
without your fix and passes with it. This is non-negotiable. If you fail to do
this I WILL FUCKING KILL YOU.

## Building

- Use `CARGO_TARGET_DIR=target/test cargo build` for builds, NOT plain `cargo build`.
  The user runs `cargo run` which uses `target/debug`. Using a separate target dir
  avoids colliding and forcing full rebuilds.

- Node.js 18+ is required for tests. On this machine use:
  `export PATH="/home/aorenste/.conda/envs/rust/bin:$PATH"`

## Testing

- `CARGO_TARGET_DIR=target/test cargo test -- --test-threads=2` for Rust + JS unit tests.
  E2E tests each spawn a server + Chromium + tmux, so limit parallelism to avoid
  resource contention on shared machines. With unlimited threads on a 192-CPU machine,
  22 simultaneous Chromium instances cause timeouts.
- Playwright E2E tests use `target/test` automatically (configured in playwright.config.js)
- The E2E test runner wraps npx in `timeout 180` because Playwright can hang
  on exit due to tmux child processes
- E2E tests run in parallel (4 workers). Each test file MUST use a unique project
  name and MUST only clean up its own workspaces (filter by project name). Never
  delete all workspaces — that nukes other tests running in parallel.
- Use `e2e/helpers.js` (`setupWorkspace`, `teardownWorkspace`, `makeHelpers`) for
  new test files to avoid boilerplate and ensure correct cleanup.
- Prefer `waitForFunction` polling over `waitForTimeout` sleeps. Sleeps are flaky
  under load and waste time. Poll for the actual condition you're waiting for.
- Don't use real Claude in tests. Simulate alt-screen apps with `less`, `vi`, or
  a `python3 -c` script that writes escape sequences and sleeps.
- Each E2E test file is a separate cargo test (`test_e2e_{name}`) that starts its
  own server with a unique port and tmux socket via `startServer()` in `beforeAll`.
  This eliminates cross-test tmux contention. No shared server or tmux socket.
- NEVER use hardcoded timeouts for readiness detection. Use deterministic signals:
  poll for the condition you're waiting for, detect errors immediately (e.g.
  `entry.connectError`), and let the global test timeout be the only bail-out.
  Timeouts are for emergencies, not for flow control.

## tmux

- tmux sessions are created in `launch_project` (agent window) and `create_tab` (shell windows)
- The terminal WebSocket handler only attaches to existing sessions, never creates them
- On reconnect, pane content is restored via `capture_pane_with_cursor` (scrollback + visible area)
- Alternate screen state is queried from tmux (`#{alternate_on}`) on connect; if active,
  `\x1b[?1049h` is sent to xterm.js before the capture-pane content so the buffers match
- Shell tabs auto-close when their pane exits. Detection uses `%unlinked-window-close`
  (not `%exit`) in tmux control mode — `%exit` fires for any session kill (including
  reconnection cleanup) while `%unlinked-window-close` only fires when a window is
  actually destroyed. The server sends `{"type":"pane_exit"}` only for `WindowClosed`
  events, and the browser calls `closeTab()` only for shell tabs (numeric key), not agent tabs.
