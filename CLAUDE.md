# AgentDispatch project conventions

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

## tmux

- tmux sessions are created in `launch_project` (agent window) and `create_tab` (shell windows)
- The terminal WebSocket handler only attaches to existing sessions, never creates them
- Output history is in-memory; on server restart, falls back to `capture_pane_with_cursor`
- Alternate screen state is queried from tmux (`#{alternate_on}`) on connect
