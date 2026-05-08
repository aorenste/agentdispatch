use std::io::Write as IoWrite;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::process::Command;

use actix_web::{HttpRequest, HttpResponse, get, web};
use nix::libc;
use serde::Deserialize;

use crate::tmux;
use crate::tmux_cc::{self, CcReader, CcEvent, CcWriter};

pub type UseTmux = web::Data<bool>;

fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Set terminal size on a PTY master fd.
fn set_winsize(fd: std::os::fd::RawFd, cols: u16, rows: u16) {
    let ws = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
    }
}

#[derive(Deserialize)]
pub struct TerminalQuery {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    cmd: Option<String>,
    #[serde(default)]
    workspace_id: Option<i64>,
    #[serde(default)]
    tab_id: Option<String>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

/// What kind of terminal session to create
enum SessionMode {
    /// Direct shell — raw PTY passthrough
    Direct,
    /// tmux control mode — parse %output, send-keys -H
    TmuxControl { pane_id: String, link_name: String, window_id: String, initial_alt_screen: bool, initial_title: Option<String>, pass_mouse: bool, tmux_session: String, tmux_window: String },
}

#[get("/api/terminal")]
pub async fn ws_terminal(
    req: HttpRequest,
    stream: web::Payload,
    query: web::Query<TerminalQuery>,
    use_tmux: UseTmux,
    db: crate::projects::Db,
) -> Result<HttpResponse, actix_web::Error> {
    let cwd = query.cwd.clone();
    let cmd = query.cmd.clone();
    let workspace_id = query.workspace_id;
    let tab_id = query.tab_id.clone();
    let init_cols = query.cols.unwrap_or(80);
    let init_rows = query.rows.unwrap_or(24);

    // Determine what to spawn. Tmux operations run on a blocking thread pool
    // to avoid stalling the async runtime when multiple connections arrive.
    let (spawn_cmd, spawn_args, mode) = if **use_tmux && workspace_id.is_some() && tab_id.is_some() {
        let ws_id = workspace_id.unwrap();
        let tid = tab_id.as_ref().unwrap().clone();
        let tmux_session = format!("ws-{ws_id}");
        let tmux_window = tid;
        let tmux_session2 = tmux_session.clone();
        let tmux_window2 = tmux_window.clone();

        let result = web::block(move || {
            if !tmux::has_session(&tmux_session) {
                return Err(format!("tmux session {tmux_session} not found — workspace may need to be relaunched"));
            }
            if !tmux::has_window(&tmux_session, &tmux_window) {
                return Err(format!("tmux window {tmux_window} not found in {tmux_session}"));
            }
            let (c, a, pane_id, link_name, window_id) = tmux::attach_args(&tmux_session, &tmux_window)?;
            let initial_alt_screen = tmux::is_alternate_screen(&tmux_session, &tmux_window);
            let initial_title = tmux::pane_title(&tmux_session, &tmux_window);
            tlog!("[terminal] {tmux_session}:{tmux_window} pane={pane_id} window={window_id} alt_screen={initial_alt_screen} title={initial_title:?}");
            Ok((c, a, pane_id, link_name, window_id, initial_alt_screen, initial_title))
        }).await.map_err(|e| actix_web::error::ErrorInternalServerError(format!("{e}")))?
          .map_err(|e| actix_web::error::ErrorNotFound(e))?;

        let (c, a, pane_id, link_name, window_id, initial_alt_screen, initial_title) = result;
        let pass_mouse = tab_id.as_deref()
            .and_then(|t| t.strip_prefix("tab-"))
            .and_then(|id| id.parse::<i64>().ok())
            .map(|id| {
                let conn = db.lock().unwrap();
                crate::db::get_tab_mouse_wheel_fs(&conn, id)
            })
            .unwrap_or(false);
        (c, a, SessionMode::TmuxControl { pane_id, link_name, window_id, initial_alt_screen, initial_title, pass_mouse, tmux_session: tmux_session2, tmux_window: tmux_window2 })
    } else {
        let shell = user_shell();
        let args = if let Some(ref run_cmd) = cmd {
            vec!["-ic".to_string(), run_cmd.clone()]
        } else {
            vec![]
        };
        (shell, args, SessionMode::Direct)
    };

    let (response, mut session, msg_stream) = actix_ws::handle(&req, stream)?;

    // Open PTY
    let pty = nix::pty::openpty(None, None).map_err(|e| {
        actix_web::error::ErrorInternalServerError(format!("openpty failed: {}", e))
    })?;

    let master_fd = pty.master;
    let slave_fd = pty.slave;

    let master_raw = {
        use std::os::fd::AsRawFd;
        master_fd.as_raw_fd()
    };

    set_winsize(master_raw, init_cols, init_rows);

    // Spawn child process
    let slave_raw = {
        use std::os::fd::AsRawFd;
        slave_fd.as_raw_fd()
    };

    let mut command = Command::new(&spawn_cmd);
    if !spawn_args.is_empty() {
        command.args(&spawn_args);
    }
    command.env("TERM", "xterm-256color");
    command.env_remove("TMUX");
    command.env_remove("TMUX_PANE");
    if matches!(mode, SessionMode::Direct) {
        command.env_remove("INSIDE_EMACS");
        command.env_remove("TERMCAP");
        command.env_remove("TERM_PROGRAM");
        command.env_remove("TERM_PROGRAM_VERSION");
        command.env_remove("COLUMNS");
        command.env_remove("LINES");
    }
    if let Some(ref dir) = cwd {
        if matches!(mode, SessionMode::Direct) {
            command.current_dir(dir);
        }
    }
    let child = unsafe {
        command.pre_exec(move || {
                libc::setsid();
                libc::ioctl(slave_raw, libc::TIOCSCTTY, 0);
                libc::dup2(slave_raw, 0);
                libc::dup2(slave_raw, 1);
                libc::dup2(slave_raw, 2);
                if slave_raw > 2 {
                    libc::close(slave_raw);
                }
                Ok(())
            })
            .spawn()
    };

    // Close slave fd in parent — child has its own copy
    drop(slave_fd);

    let child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = session.close(None).await;
            return Err(actix_web::error::ErrorInternalServerError(
                format!("Failed to spawn process: {}", e),
            ));
        }
    };

    // Wrap master fd in async file for tokio
    let master_fd_raw = master_raw;
    let master_owned: OwnedFd = master_fd;
    let std_file = std::fs::File::from(master_owned);
    unsafe {
        let flags = libc::fcntl(master_fd_raw, libc::F_GETFL);
        libc::fcntl(master_fd_raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let tokio_fd = tokio::io::unix::AsyncFd::new(std_file).map_err(|e| {
        actix_web::error::ErrorInternalServerError(format!("AsyncFd failed: {}", e))
    })?;
    let tokio_fd = std::sync::Arc::new(tokio_fd);

    match mode {
        SessionMode::Direct => {
            spawn_direct_bridge(session, msg_stream, tokio_fd, master_fd_raw, child);
        }
        SessionMode::TmuxControl { pane_id, link_name, window_id, initial_alt_screen, initial_title, pass_mouse, tmux_session, tmux_window } => {
            let initial_content = tmux::capture_pane_with_cursor(&pane_id);

            // Send initial resize
            let resize_cmd = tmux_cc::encode_resize(init_cols, init_rows);
            std_file_write(&tokio_fd, &resize_cmd);

            // Send initial pane title if set
            if let Some(ref title) = initial_title {
                let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
                let msg = format!("{{\"type\":\"pane_title\",\"title\":\"{escaped}\"}}");
                let _ = session.text(msg).await;
            }

            // When pass_mouse is enabled and the pane is in mouse mode,
            // inject mouse tracking sequences so xterm.js enters mouse mode
            // immediately (the app already sent these, but they were stripped
            // on previous connections).
            if pass_mouse {
                let mouse_flags = tmux::pane_mouse_mode(&tmux_session, &tmux_window);
                if !mouse_flags.is_empty() {
                    let _ = session.binary(mouse_flags).await;
                }
            }

            spawn_cc_bridge(session, msg_stream, tokio_fd, master_fd_raw, child, pane_id, link_name, window_id, initial_content, init_cols, init_rows, initial_alt_screen, pass_mouse);
        }
    }

    Ok(response)
}

/// Synchronous write helper for initial commands before async tasks start.
fn std_file_write(fd: &std::sync::Arc<tokio::io::unix::AsyncFd<std::fs::File>>, data: &[u8]) {
    use std::io::Write;
    let _ = fd.get_ref().write_all(data);
}

// -- Direct shell bridge (no tmux) --

fn spawn_direct_bridge(
    mut session: actix_ws::Session,
    mut msg_stream: actix_ws::MessageStream,
    tokio_fd: std::sync::Arc<tokio::io::unix::AsyncFd<std::fs::File>>,
    master_fd_raw: std::os::fd::RawFd,
    mut child: std::process::Child,
) {
    let child_pid = child.id();

    // PTY → WebSocket
    let mut session_clone = session.clone();
    let tokio_fd_read = tokio_fd.clone();
    let pty_to_ws = actix_web::rt::spawn(async move {
        use std::io::Read;
        let mut buf = [0u8; 4096];
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
        ping_interval.tick().await;
        loop {
            tokio::select! {
                ready_result = tokio_fd_read.readable() => {
                    let mut ready = match ready_result {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    match ready.try_io(|fd| {
                        let n = fd.get_ref().read(&mut buf)?;
                        Ok(n)
                    }) {
                        Ok(Ok(0)) => break,
                        Ok(Ok(n)) => {
                            if session_clone.binary(buf[..n].to_vec()).await.is_err() {
                                break;
                            }
                        }
                        Ok(Err(_)) => break,
                        Err(_would_block) => continue,
                    }
                }
                _ = ping_interval.tick() => {
                    if session_clone.ping(b"").await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = session_clone.close(None).await;
    });

    // WebSocket → PTY
    let tokio_fd_write = tokio_fd;
    actix_web::rt::spawn(async move {
        use actix_ws::Message;

        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("resize") {
                            let cols = val.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows = val.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            set_winsize(master_fd_raw, cols, rows);
                            continue;
                        }
                    }
                    let bytes = text.as_bytes().to_vec();
                    if async_write(&tokio_fd_write, &bytes).await.is_err() { break; }
                }
                Message::Binary(data) => {
                    if async_write(&tokio_fd_write, &data).await.is_err() { break; }
                }
                Message::Ping(bytes) => {
                    if session.pong(&bytes).await.is_err() { break; }
                }
                Message::Pong(_) => {}
                Message::Close(_) => break,
                _ => {}
            }
        }

        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child_pid as i32),
            nix::sys::signal::Signal::SIGHUP,
        );
        let _ = child.wait();
        pty_to_ws.abort();
        let _ = session.close(None).await;
    });
}

// -- tmux control mode (-C) bridge --

fn spawn_cc_bridge(
    mut session: actix_ws::Session,
    mut msg_stream: actix_ws::MessageStream,
    tokio_fd: std::sync::Arc<tokio::io::unix::AsyncFd<std::fs::File>>,
    _master_fd_raw: std::os::fd::RawFd,
    mut child: std::process::Child,
    pane_id: String,
    link_name: String,
    window_id: String,
    initial_content: Option<Vec<u8>>,
    _init_cols: u16,
    _init_rows: u16,
    initial_alt_screen: bool,
    pass_mouse: bool,
) {
    let child_pid = child.id();

    // PTY → WebSocket: parse tmux control mode output via CcReader
    let mut session_clone = session.clone();
    let tokio_fd_read = tokio_fd.clone();
    let read_pane_id = pane_id.clone();
    let log_pane = pane_id.clone();
    let log_link = link_name.clone();
    let pty_to_ws = actix_web::rt::spawn(async move {
        use std::io::Read;

        // Replay pane content on reconnect.
        let mut last_alt_screen = initial_alt_screen;
        if last_alt_screen {
            // Switch xterm.js to alt buffer BEFORE writing capture-pane content.
            // This ensures: (1) content doesn't create scrollback in the normal
            // buffer, (2) live output from the app renders correctly since xterm.js
            // is in the same buffer mode as tmux.
            if session_clone.binary(b"\x1b[?1049h".to_vec()).await.is_err() {
                let _ = session_clone.close(None).await;
                return;
            }
        }
        if let Some(content) = initial_content {
            if !content.is_empty() {
                if session_clone.binary(content).await.is_err() {
                    let _ = session_clone.close(None).await;
                    return;
                }
            }
        }
        // Tell the browser about alt screen state (for badge/CSS).
        if last_alt_screen {
            let msg = format!("{{\"type\":\"altscreen\",\"active\":true,\"reconnect\":true}}");
            if session_clone.text(msg).await.is_err() {
                let _ = session_clone.close(None).await;
                return;
            }
        }

        // Debug: log all output sent to the browser for replay/analysis.
        // Enable with AGENTDISPATCH_DUMP_OUTPUT=1.
        let mut dump_file = if std::env::var("AGENTDISPATCH_DUMP_OUTPUT").is_ok() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let dump_path = format!("/tmp/agentdispatch-output-{}-{ts}.bin", read_pane_id.replace('%', ""));
            let f = std::fs::File::create(&dump_path).ok();
            if f.is_some() {
                tlog!("[debug] logging terminal output to {dump_path}");
            }
            f
        } else {
            None
        };

        let mut reader = CcReader::new(read_pane_id);
        reader.set_pass_mouse(pass_mouse);
        reader.set_window_id(window_id.clone());
        reader.set_alternate_screen(last_alt_screen);
        let mut raw_buf = [0u8; 4096];
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
        ping_interval.tick().await;

        // Register to receive cross-reader notifications when OUR window
        // is unlinked (tmux only delivers that event to grouped peers).
        let registered_window_id = window_id.clone();
        let own_close = tmux_cc::register_window_close(registered_window_id.clone());

        'outer: loop {
            tokio::select! {
                _ = own_close.notified() => {
                    // A peer observed %unlinked-window-close for our window. That event
                    // fires both for real destruction AND when a linked session dies
                    // (tmux broadcasts it as "unlinked from the dying session"). Verify
                    // the window is truly gone before reporting the pane as exited.
                    let wid = registered_window_id.clone();
                    let still_alive = tokio::task::spawn_blocking(move || tmux::window_exists(&wid))
                        .await
                        .unwrap_or(false);
                    if still_alive {
                        tlog!("[terminal] {log_link} pane={log_pane}: peer close notification ignored (window {registered_window_id} still exists)");
                        continue 'outer;
                    }
                    tlog!("[terminal] {log_link} pane={log_pane}: window closed (observed by peer), sending pane_exit");
                    let _ = session_clone.text(r#"{"type":"pane_exit"}"#.to_string()).await;
                    break 'outer;
                }
                ready_result = tokio_fd_read.readable() => {
                    let mut ready = match ready_result {
                        Ok(r) => r,
                        Err(e) => {
                            tlog!("[terminal] {log_link} pane={log_pane}: readable error: {e}");
                            break;
                        }
                    };
                    match ready.try_io(|fd| {
                        let n = fd.get_ref().read(&mut raw_buf)?;
                        Ok(n)
                    }) {
                        Ok(Ok(0)) => {
                            tlog!("[terminal] {log_link} pane={log_pane}: PTY EOF");
                            break;
                        }
                        Ok(Ok(n)) => {
                            reader.feed(&raw_buf[..n]);
                            while let Some(event) = reader.next_event() {
                                match event {
                                    CcEvent::Output { data: decoded, alternate_screen } => {
                                        if let Some(ref mut f) = dump_file {
                                            // Frame format: 4-byte big-endian length + payload
                                            let len = (decoded.len() as u32).to_be_bytes();
                                            let _ = f.write_all(&len);
                                            let _ = f.write_all(&decoded);
                                        }
                                        if session_clone.binary(decoded).await.is_err() {
                                            break 'outer;
                                        }
                                        // Notify browser of alternate screen state changes
                                        if alternate_screen != last_alt_screen {
                                            last_alt_screen = alternate_screen;
                                            let msg = format!("{{\"type\":\"altscreen\",\"active\":{alternate_screen}}}");
                                            if session_clone.text(msg).await.is_err() {
                                                break 'outer;
                                            }
                                        }
                                    }
                                    CcEvent::Exit => {
                                        tlog!("[terminal] {log_link} pane={log_pane}: %exit (session ended)");
                                        break 'outer;
                                    }
                                    CcEvent::WindowClosed => {
                                        tlog!("[terminal] {log_link} pane={log_pane}: window closed (pane exited), sending pane_exit");
                                        let _ = session_clone.text(r#"{"type":"pane_exit"}"#.to_string()).await;
                                        break 'outer;
                                    }
                                    CcEvent::OtherWindowClosed { window_id: wid } => {
                                        tmux_cc::notify_window_closed(&wid);
                                    }
                                    CcEvent::PaneTitleChanged { title } => {
                                        let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
                                        let msg = format!("{{\"type\":\"pane_title\",\"title\":\"{escaped}\"}}");
                                        let _ = session_clone.text(msg).await;
                                    }
                                }
                            }
                        }
                        Ok(Err(_)) => break,
                        Err(_would_block) => continue,
                    }
                }
                _ = ping_interval.tick() => {
                    if session_clone.ping(b"").await.is_err() {
                        break;
                    }
                }
            }
        }
        tmux_cc::unregister_window_close(&registered_window_id);
        let _ = session_clone.close(None).await;
    });

    // WebSocket → PTY: translate to tmux control mode commands via CcWriter
    let tokio_fd_write = tokio_fd;
    let writer = CcWriter::new(pane_id.clone());
    actix_web::rt::spawn(async move {
        use actix_ws::Message;

        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("resize") {
                            let cols = val.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows = val.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            if async_write(&tokio_fd_write, &writer.resize(cols, rows)).await.is_err() { break; }
                            continue;
                        }
                    }
                    if async_write(&tokio_fd_write, &writer.input(text.as_bytes())).await.is_err() { break; }
                }
                Message::Binary(data) => {
                    if async_write(&tokio_fd_write, &writer.input(&data)).await.is_err() { break; }
                }
                Message::Ping(bytes) => {
                    if session.pong(&bytes).await.is_err() { break; }
                }
                Message::Pong(_) => {}
                Message::Close(_) => break,
                _ => {}
            }
        }

        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child_pid as i32),
            nix::sys::signal::Signal::SIGHUP,
        );
        let _ = child.wait();
        tmux::kill_session(&link_name);
        pty_to_ws.abort();
        let _ = session.close(None).await;
    });
}

/// Async write to the PTY fd.
///
/// Tracks how many bytes have been written so partial writes don't get
/// re-sent. `write_all` doesn't return the number written on a partial
/// failure, so under back-pressure (large pastes, slow consumer) it would
/// keep retrying from offset 0 — duplicating earlier bytes and, in the
/// worst case, never terminating.
async fn async_write(
    fd: &std::sync::Arc<tokio::io::unix::AsyncFd<std::fs::File>>,
    data: &[u8],
) -> Result<(), std::io::Error> {
    use std::io::Write;
    let mut written = 0;
    while written < data.len() {
        let mut ready = fd.writable().await?;
        match ready.try_io(|fd| fd.get_ref().write(&data[written..])) {
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "write returned 0",
                ));
            }
            Ok(Ok(n)) => written += n,
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reproduces the partial-write duplication bug. With a small kernel
    /// buffer and a slow reader, write_all hits WouldBlock partway through.
    /// The buggy retry loop redoes write_all from offset 0, so any bytes
    /// already accepted by the kernel get re-emitted.
    ///
    /// We write a 1 MiB unique sequence; the reader must observe exactly
    /// the same bytes back. If the bug is present, output > input (dups).
    #[tokio::test]
    async fn test_async_write_no_duplication_under_partial_writes() {
        use std::io::Read;
        use std::os::fd::{FromRawFd, IntoRawFd};

        // Create pipe and grab raw fds.
        let (read_fd, write_fd) = nix::unistd::pipe().expect("pipe");
        let read_raw = read_fd.into_raw_fd();
        let write_raw = write_fd.into_raw_fd();

        // Linux: shrink pipe buffer to one page (4 KiB) so a 1 MiB write
        // is guaranteed to partial-write many times. Best-effort — the
        // default 64 KiB buffer also exposes the bug for inputs > 64 KiB.
        #[cfg(target_os = "linux")]
        unsafe {
            let _ = nix::libc::fcntl(write_raw, nix::libc::F_SETPIPE_SZ, 4096);
        }

        // Set write end non-blocking (required by AsyncFd).
        unsafe {
            let flags = nix::libc::fcntl(write_raw, nix::libc::F_GETFL);
            nix::libc::fcntl(write_raw, nix::libc::F_SETFL, flags | nix::libc::O_NONBLOCK);
        }

        // Wrap write end as AsyncFd<File>.
        let write_file = unsafe { std::fs::File::from_raw_fd(write_raw) };
        let write_async =
            std::sync::Arc::new(tokio::io::unix::AsyncFd::new(write_file).expect("AsyncFd"));

        // Reader thread: drains slowly so the writer keeps hitting backpressure.
        let read_file = unsafe { std::fs::File::from_raw_fd(read_raw) };
        let reader_handle = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 256];
            let mut reader = read_file;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        all.extend_from_slice(&buf[..n]);
                        // Slight sleep keeps the pipe near-full, forcing partial writes.
                        std::thread::sleep(std::time::Duration::from_micros(20));
                    }
                    Err(e) => panic!("read error: {e}"),
                }
            }
            all
        });

        // 1 MiB unique pattern so any duplication is byte-detectable.
        let input: Vec<u8> = (0..(1024 * 1024)).map(|i| (i % 251) as u8).collect();

        // Buggy implementations can loop forever (writing the same prefix
        // repeatedly under sustained back-pressure), so cap the run time.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async_write(&write_async, &input),
        )
        .await;

        match result {
            Err(_) => panic!("async_write hung — likely retry-from-offset-0 bug"),
            Ok(Err(e)) => panic!("async_write failed: {e}"),
            Ok(Ok(())) => {}
        }

        // Close the write side so the reader sees EOF.
        drop(write_async);

        let output = reader_handle.join().expect("reader thread");
        assert_eq!(
            output.len(),
            input.len(),
            "output length mismatch — likely duplication: in={} out={}",
            input.len(),
            output.len()
        );
        assert_eq!(output, input, "byte sequence mismatch");
    }
}
