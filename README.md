# AgentDispatch

Web-based terminal manager for running AI coding agents (Claude, Codex) across multiple projects with persistent sessions.

## What it does

- **Projects**: Configure directories with agent type, git worktree support, conda env, and agent flags
- **Workspaces**: Launch isolated workspaces per project, each with an agent pane and shell tabs
- **Persistent terminals**: Sessions survive browser refreshes and server restarts via tmux control mode
- **Native scroll & selection**: xterm.js handles scrollback and text selection natively (no tmux mouse interference)
- **Copy-on-select**: Text selection automatically copies to clipboard (like iTerm2)

## Quick start

```sh
cargo run
# Open http://localhost:8915
```

Add a project via the web UI, click Launch to create a workspace.

## Options

```
--port <PORT>     Port to listen on (default: 8915)
--db <PATH>       SQLite database path (default: agentdispatch.db)
--no-tmux         Disable tmux (direct shell, no session persistence)
--reset           Kill tmux server and delete database before starting
```

## Architecture

```
Browser (xterm.js) <--WebSocket--> Rust server <--PTY--> tmux -C <--pane--> shell/claude
```

- **`src/main.rs`** — Server startup, CLI args, tmux session reconciliation
- **`src/terminal.rs`** — WebSocket↔PTY bridge (direct shell and tmux control mode)
- **`src/tmux.rs`** — tmux session/window management (subprocess calls)
- **`src/tmux_cc.rs`** — tmux control mode protocol: `CcReader` (parser), `CcWriter` (encoder)
- **`src/projects.rs`** — REST API for projects, workspaces, tabs
- **`src/db.rs`** — SQLite schema, migrations, CRUD
- **`src/web.rs`** — Static file serving, SSE events
- **`static/app.js`** — Frontend UI (extracted from index.html for testability)
- **`static/index.html`** — HTML + CSS

### tmux control mode (-C)

Instead of normal tmux (which takes over the terminal with alternate screen/cursor positioning), we use control mode. tmux sends structured `%output` messages with the raw pane output. The Rust server parses these and forwards clean terminal data to xterm.js. This means:

- xterm.js stays on its normal buffer with 10,000 lines of scrollback
- Mouse scroll and text selection work natively
- No escape sequence stripping needed
- Output history is accumulated server-side and replayed on reconnect

## Tests

```sh
# All tests (Rust unit/integration + JS unit + Playwright E2E)
cargo test

# Just Rust tests
cargo test -- --skip test_e2e --skip test_js

# Just JS unit tests
node --test static/app.test.js

# Just E2E tests
npx playwright test

# E2E setup (first time)
npm install
npx playwright install chromium
```

### Test coverage

| Area | Tests | What's covered |
|------|-------|----------------|
| DB | 26 | Migrations, project/workspace/tab CRUD, cascading deletes |
| API | 14 | All REST endpoints, validation, defaults |
| tmux | 6 | Session lifecycle, config, control mode attach |
| tmux_cc | 20 | Octal decode, hex encode, CcReader (pane filtering, partial lines, DCS stripping, exit) |
| JS unit | 27 | getProjectAgent, getTerminalConfig, buildAgentCommand, normalizeWsSubtab, escAttr |
| E2E scroll | 1 | Mouse wheel scrolls xterm.js viewport |
| E2E selection | 1 | Mouse drag creates selection, copy-on-select to clipboard |
| E2E leak | 1 | Output from one tab doesn't appear in another |
| E2E reconnect | 1 | Shell variable survives disconnect/reconnect |
| E2E launch | 3 | Launch button, special chars in names, non-git dir |
| E2E Claude | 1 | Screenshot comparison: Claude screen identical after reconnect |

## Dependencies

- Rust (2024 edition)
- tmux 3.x (for session persistence; optional with `--no-tmux`)
- Node.js 18+ (for tests only)
- Chromium (for E2E tests only, installed via `npx playwright install chromium`)
