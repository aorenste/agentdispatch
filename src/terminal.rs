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
    TmuxControl { pane_id: String, link_name: String, initial_alt_screen: bool },
}

#[get("/api/terminal")]
pub async fn ws_terminal(
    req: HttpRequest,
    stream: web::Payload,
    query: web::Query<TerminalQuery>,
    use_tmux: UseTmux,
) -> Result<HttpResponse, actix_web::Error> {
    let cwd = query.cwd.clone();
    let cmd = query.cmd.clone();
    let workspace_id = query.workspace_id;
    let tab_id = query.tab_id.clone();
    let init_cols = query.cols.unwrap_or(80);
    let init_rows = query.rows.unwrap_or(24);
    let (response, session, msg_stream) = actix_ws::handle(&req, stream)?;

    // Determine what to spawn
    let (spawn_cmd, spawn_args, mode) = if **use_tmux && workspace_id.is_some() && tab_id.is_some() {
        let ws_id = workspace_id.unwrap();
        let tid = tab_id.as_ref().unwrap();
        let tmux_session = format!("ws-{ws_id}");
        let tmux_window = tid.clone();

        // Sessions/windows are created by launch_project and create_tab.
        // The terminal handler only attaches to existing ones.
        if !tmux::has_session(&tmux_session) {
            return Err(actix_web::error::ErrorNotFound(
                format!("tmux session {tmux_session} not found — workspace may need to be relaunched"),
            ));
        }
        if !tmux::has_window(&tmux_session, &tmux_window) {
            return Err(actix_web::error::ErrorNotFound(
                format!("tmux window {tmux_window} not found in {tmux_session}"),
            ));
        }

        let (c, a, pane_id, link_name) = tmux::attach_args(&tmux_session, &tmux_window)
            .map_err(|e| actix_web::error::ErrorInternalServerError(
                format!("Failed to attach to tmux: {e}"),
            ))?;
        let initial_alt_screen = tmux::is_alternate_screen(&tmux_session, &tmux_window);
        (c, a, SessionMode::TmuxControl { pane_id, link_name, initial_alt_screen })
    } else {
        // Direct shell (no tmux)
        let shell = user_shell();
        let args = if let Some(ref run_cmd) = cmd {
            vec!["-ic".to_string(), run_cmd.clone()]
        } else {
            vec![]
        };
        (shell, args, SessionMode::Direct)
    };

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
        SessionMode::TmuxControl { pane_id, link_name, initial_alt_screen } => {
            let initial_content = tmux::capture_pane_with_cursor(&pane_id);

            // Send initial resize
            let resize_cmd = tmux_cc::encode_resize(init_cols, init_rows);
            std_file_write(&tokio_fd, &resize_cmd);

            spawn_cc_bridge(session, msg_stream, tokio_fd, master_fd_raw, child, pane_id, link_name, initial_content, init_cols, init_rows, initial_alt_screen);
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
    initial_content: Option<Vec<u8>>,
    _init_cols: u16,
    _init_rows: u16,
    initial_alt_screen: bool,
) {
    let child_pid = child.id();

    // PTY → WebSocket: parse tmux control mode output via CcReader
    let mut session_clone = session.clone();
    let tokio_fd_read = tokio_fd.clone();
    let read_pane_id = pane_id.clone();
    let pty_to_ws = actix_web::rt::spawn(async move {
        use std::io::Read;

        // Replay accumulated output history (reconnect replay)
        let mut last_alt_screen = initial_alt_screen;
        if let Some(content) = initial_content {
            if !content.is_empty() {
                if session_clone.binary(content).await.is_err() {
                    let _ = session_clone.close(None).await;
                    return;
                }
            }
        }
        // Send initial altscreen state to browser (from tmux query).
        // We always trust tmux's #{alternate_on} as the source of truth
        // rather than scanning history, which may be stale.
        if last_alt_screen {
            let msg = format!("{{\"type\":\"altscreen\",\"active\":{last_alt_screen}}}");
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
                eprintln!("[debug] logging terminal output to {dump_path}");
            }
            f
        } else {
            None
        };

        let mut reader = CcReader::new(read_pane_id);
        reader.set_alternate_screen(last_alt_screen);
        let mut raw_buf = [0u8; 4096];
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
        ping_interval.tick().await;

        'outer: loop {
            tokio::select! {
                ready_result = tokio_fd_read.readable() => {
                    let mut ready = match ready_result {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    match ready.try_io(|fd| {
                        let n = fd.get_ref().read(&mut raw_buf)?;
                        Ok(n)
                    }) {
                        Ok(Ok(0)) => break,
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
                                    CcEvent::Exit => break 'outer,
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
async fn async_write(
    fd: &std::sync::Arc<tokio::io::unix::AsyncFd<std::fs::File>>,
    data: &[u8],
) -> Result<(), std::io::Error> {
    use std::io::Write;
    loop {
        let mut ready = fd.writable().await?;
        match ready.try_io(|fd| fd.get_ref().write_all(data)) {
            Ok(result) => return result,
            Err(_would_block) => continue,
        }
    }
}
