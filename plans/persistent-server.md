# Terminal persistence: server-side plan (for later evaluation)

## Overview
Decouple PTY lifecycle from WebSocket lifecycle so terminals survive network drops.

## Architecture

### New module: `src/session.rs` — PTY session manager

```
PtySession {
    id: String,                          // e.g. "tab-42" or "claude-7"
    master_fd: Arc<AsyncFd<File>>,       // PTY master
    master_raw: RawFd,                   // for ioctl
    child_pid: u32,                      // for cleanup
    scrollback: Mutex<VecDeque<u8>>,     // ring buffer, ~1MB cap
    ws_sender: Mutex<Option<actix_ws::Session>>,  // currently attached client
    reader_handle: JoinHandle<()>,       // PTY reader task
}

SessionRegistry = Arc<Mutex<HashMap<String, Arc<PtySession>>>>
```

### PTY reader task (one per session, runs forever)
```rust
loop {
    // read from PTY
    let n = async_read(master_fd, &mut buf).await;
    if n == 0 { break; }  // child exited

    // always append to scrollback
    scrollback.lock().append(&buf[..n]);
    scrollback.lock().truncate_front_if_over_cap();

    // forward to attached WS if any
    if let Some(ws) = ws_sender.lock().as_mut() {
        if ws.binary(buf[..n].to_vec()).await.is_err() {
            *ws_sender.lock() = None;  // client disconnected
        }
    }
}
// child exited — mark session as dead
```

### WebSocket endpoint changes (`GET /api/terminal`)

New param: `session_id` (required for reconnect, optional for create)

```
if session_id exists in registry:
    # REATTACH
    1. Replay scrollback buffer contents to new WS
    2. Set session.ws_sender = Some(new_ws)
    3. Send resize to PTY if cols/rows changed
    4. Start WS→PTY write loop (same as today)
else:
    # CREATE
    1. Open PTY, spawn child (same as today)
    2. Create PtySession, register in SessionRegistry
    3. Spawn PTY reader task
    4. Set ws_sender = Some(ws)
    5. Start WS→PTY write loop
```

### WS→PTY write loop (runs per connection)
Same as today but on WS close:
- Do NOT kill child process
- Just set ws_sender = None and exit the loop
- Session stays alive, reader task keeps buffering

### Session cleanup
- Explicit destroy (tab close / workspace destroy): kill child, remove from registry
- Child exit: reader task detects EOF, marks session dead, next attach attempt cleans up
- New endpoint: `DELETE /api/sessions/{id}` or reuse existing tab delete

### Client changes (`static/index.html`)

Minimal:
1. Add `session_id` param to WebSocket URL (use tab ID or "claude-{wsId}")
2. On WS close, don't show "[Connection closed]" — instead show "[Reconnecting...]"
3. Auto-reconnect with same session_id after a delay
4. On reconnect, xterm.reset() before replaying scrollback to get clean state

### Files to modify
- `src/session.rs` — new file, ~200 lines: PtySession, SessionRegistry, create/attach/detach/destroy
- `src/terminal.rs` — rewrite to use session registry instead of owning PTY directly
- `src/main.rs` — create SessionRegistry, pass as app_data
- `static/index.html` — add session_id param, auto-reconnect logic

### Estimated complexity
~300 lines of Rust, ~30 lines of JS changes. Main tricky part is the shared mutable ws_sender coordination between the reader task and the WS handler.

## Security considerations (if dropping ET requirement)
- Add token auth: generate random token on start, print in URL, check via cookie/header on WS upgrade
- Or bind to localhost only and require SSH/ET tunnel
- Current TLS + corporate network may be sufficient

## Comparison with ET-only approach

| Aspect | ET-only | Server-side |
|---|---|---|
| Code changes | None | ~300 lines |
| Works without ET | No | Yes |
| Multi-device | No | Yes |
| Buffer control | ET decides | We control (1MB ring) |
| Child process survives | Only if ET stays up | Always (until explicit kill) |
| Browser refresh | Loses state | Reconnects to same session |
