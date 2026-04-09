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

- `CARGO_TARGET_DIR=target/test cargo test` for Rust + JS unit tests
- Playwright E2E tests use `target/test` automatically (configured in playwright.config.js)
- The E2E test runner (`test_e2e_playwright`) wraps npx in `timeout 60` because
  Playwright can hang on exit due to tmux child processes
- E2E tests use a separate tmux socket (`agentdispatch-test` via env var
  `AGENTDISPATCH_TMUX_SOCKET`) to avoid killing the user's real sessions
- E2E tests run in parallel (4 workers). Each test file MUST use a unique project
  name and MUST only clean up its own workspaces (filter by project name). Never
  delete all workspaces — that nukes other tests running in parallel.
- Use `e2e/helpers.js` (`setupWorkspace`, `teardownWorkspace`, `makeHelpers`) for
  new test files to avoid boilerplate and ensure correct cleanup.
- Prefer `waitForFunction` polling over `waitForTimeout` sleeps. Sleeps are flaky
  under load and waste time. Poll for the actual condition you're waiting for.
- Don't use real Claude in tests. Simulate alt-screen apps with `less`, `vi`, or
  a `python3 -c` script that writes escape sequences and sleeps.

## tmux

- tmux sessions are created in `launch_project` (agent window) and `create_tab` (shell windows)
- The terminal WebSocket handler only attaches to existing sessions, never creates them
- On reconnect, pane content is restored via `capture_pane_with_cursor` (visible area only)
- Alternate screen state is queried from tmux (`#{alternate_on}`) on connect; if active,
  `\x1b[?1049h` is sent to xterm.js before the capture-pane content so the buffers match
