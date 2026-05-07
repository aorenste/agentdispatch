use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

fn socket_name() -> String {
    std::env::var("AGENTDISPATCH_TMUX_SOCKET").unwrap_or_else(|_| "agentdispatch".to_string())
}

/// Full filesystem path of the tmux socket file we use.
pub fn socket_path() -> String {
    let uid = unsafe { nix::libc::getuid() };
    format!("/tmp/tmux-{uid}/{}", socket_name())
}

static ATTACH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Outcome of probing the tmux socket file. Made public for tests and
/// startup diagnostics.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SocketProbe {
    /// Socket file does not exist.
    Missing,
    /// Socket file exists and a process is accepting connections on it.
    Live,
    /// Socket file exists but nothing is listening (ECONNREFUSED).
    /// Definitely safe to unlink.
    Stale,
    /// Socket file exists but connect() returned an error we don't
    /// understand (EACCES, EAGAIN, etc). Conservative — do not unlink.
    Unknown(std::io::ErrorKind),
}

/// Probe the socket by attempting a Unix-domain connect. Unlike asking
/// tmux, this talks directly to the kernel so it can't be fooled by a
/// tmux client that's merely slow.
pub fn probe_socket(path: &str) -> SocketProbe {
    if !std::path::Path::new(path).exists() {
        return SocketProbe::Missing;
    }
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => SocketProbe::Live,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => SocketProbe::Stale,
        Err(e) => SocketProbe::Unknown(e.kind()),
    }
}

/// Remove the tmux socket file *only* if we are confident nothing is
/// listening on it. We verify this with a direct `connect(2)` rather
/// than relying on a single `tmux list-sessions` call — a transient
/// failure of that command used to cause us to unlink the socket out
/// from under a healthy server, leaving the sessions orphaned (alive
/// but unreachable via the path).
fn clean_stale_socket() {
    let path = socket_path();
    let probe = probe_socket(&path);
    tlog!("clean_stale_socket: path={path} probe={probe:?}");
    match probe {
        SocketProbe::Missing | SocketProbe::Live | SocketProbe::Unknown(_) => {
            // Nothing to do (or not safe to do anything).
            return;
        }
        SocketProbe::Stale => {}
    }

    // Double-check via tmux as a belt-and-braces guard. Retry a few
    // times to ride out transient hiccups. Only unlink if every attempt
    // agrees the server is gone.
    for attempt in 1..=3 {
        let output = tmux_base().args(["list-sessions"]).output();
        match output {
            Ok(o) if o.status.success() => {
                tlog!(
                    "clean_stale_socket: list-sessions succeeded on attempt {attempt} — \
                     server came back, not unlinking"
                );
                return;
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let stderr = stderr.trim();
                let recognised = stderr.contains("server exited unexpectedly")
                    || stderr.contains("no server running");
                tlog!(
                    "clean_stale_socket: attempt {attempt} failed (status={}): {stderr}",
                    o.status
                );
                if !recognised {
                    tlog!("clean_stale_socket: unrecognised error, not unlinking");
                    return;
                }
            }
            Err(e) => {
                tlog!("clean_stale_socket: attempt {attempt} run error: {e} — not unlinking");
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    match std::fs::remove_file(&path) {
        Ok(_) => tlog!("clean_stale_socket: removed stale tmux socket: {path}"),
        Err(e) => tlog!("clean_stale_socket: failed to remove {path}: {e}"),
    }
}

/// Log everything we know about the tmux socket at startup. If the
/// socket file is ever replaced or corrupted between runs, these lines
/// will show the before/after state side by side in the log file.
pub fn log_startup_diagnostics() {
    let path = socket_path();
    tlog!("tmux diag: socket path = {path}");

    match std::fs::metadata(&path) {
        Ok(md) => {
            use std::os::unix::fs::MetadataExt as _;
            let mtime = md.mtime();
            tlog!(
                "tmux diag: socket file inode={} mode={:o} uid={} mtime={} size={}",
                md.ino(),
                md.mode(),
                md.uid(),
                mtime,
                md.len()
            );
        }
        Err(e) => tlog!("tmux diag: no socket file ({e})"),
    }

    tlog!("tmux diag: probe = {:?}", probe_socket(&path));

    match Command::new("tmux").arg("-V").output() {
        Ok(o) => tlog!(
            "tmux diag: version = {}",
            String::from_utf8_lossy(&o.stdout).trim()
        ),
        Err(e) => tlog!("tmux diag: tmux -V failed: {e}"),
    }

    let ls = tmux_base().args(["list-sessions"]).output();
    match ls {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            let count = body.lines().count();
            tlog!("tmux diag: server reachable, {count} session(s)");
            for line in body.lines() {
                tlog!("tmux diag:   {line}");
            }
        }
        Ok(o) => tlog!(
            "tmux diag: list-sessions failed ({}): {}",
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => tlog!("tmux diag: list-sessions run error: {e}"),
    }
}

fn tmux_base() -> Command {
    let mut cmd = Command::new("tmux");
    let sock = socket_name();
    cmd.args(["-L", &sock, "-f", "/dev/null"]);
    // Clean environment for tmux server processes
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    cmd.env_remove("INSIDE_EMACS");
    cmd.env_remove("TERMCAP");
    cmd.env_remove("TERM_PROGRAM");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    cmd.env_remove("COLUMNS");
    cmd.env_remove("LINES");
    cmd.env("TERM", "xterm-256color");
    cmd
}

pub fn has_session(session: &str) -> bool {
    tmux_base()
        .args(["has-session", "-t", session])
        .output()
        .is_ok_and(|o| o.status.success())
}

pub fn has_window(session: &str, window: &str) -> bool {
    let target = format!("{session}:{window}");
    tmux_base()
        .args(["display-message", "-t", &target, "-p", "#{window_id}"])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Check whether a window with the given `@N` id still exists in any session.
/// `%unlinked-window-close @X` fires both for real destruction AND when a
/// linked session dies (tmux broadcasts that its windows were unlinked from
/// the dying session, even though they remain in the main session). This
/// helper distinguishes the two so callers can ignore spurious notifications.
pub fn window_exists(window_id: &str) -> bool {
    let output = tmux_base()
        .args(["list-windows", "-a", "-F", "#{window_id}"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| l.trim() == window_id)
        }
        _ => false,
    }
}

/// Apply global tmux options needed for the web UI.
/// In control mode (-C) most settings are irrelevant since tmux doesn't render
/// to the terminal. We only set history-limit for scrollback.
pub fn ensure_server_config() {
    let _ = tmux_base()
        .args(["set-option", "-g", "history-limit", "10000"])
        .output();
    // Allow apps to send OSC/DCS sequences through tmux (e.g. OSC 8 hyperlinks).
    // "all" passes unrecognized sequences through without requiring DCS wrappers.
    let _ = tmux_base()
        .args(["set-option", "-g", "allow-passthrough", "all"])
        .output();
    // Enable hyperlink support so tmux processes OSC 8 and includes it in output.
    let _ = tmux_base()
        .args(["set-option", "-ga", "terminal-features", "xterm*:hyperlinks"])
        .output();
}

pub fn new_session(session: &str, window: &str, cwd: &str, cmd: Option<&str>) -> Result<(), String> {
    new_session_ex(session, window, cwd, cmd, true)
}

pub fn new_session_ex(session: &str, window: &str, cwd: &str, cmd: Option<&str>, keep_shell: bool) -> Result<(), String> {
    let mut args = vec![
        "new-session", "-d", "-s", session, "-n", window, "-c", cwd,
    ];
    let shell_cmd;
    if let Some(c) = cmd {
        let escaped = c.replace("'", "'\\''");
        shell_cmd = if keep_shell {
            format!("bash -lc '{escaped}; exec bash -l'")
        } else {
            format!("bash -lc '{escaped}'")
        };
        args.push(&shell_cmd);
    }
    let output = tmux_base()
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run tmux: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if !keep_shell {
        // Set remain-on-exit so the pane stays visible after the build finishes.
        // Race note: if the pane exits before this, the window is destroyed and
        // init_pane_status returns None — check_building_workspaces handles this
        // by looking for a status file written by the wrapper command.
        let target = format!("{session}:{window}");
        let _ = tmux_base()
            .args(["set-option", "-t", &target, "remain-on-exit", "on"])
            .output();
    }
    ensure_server_config();
    Ok(())
}

pub fn new_window(session: &str, window: &str, cwd: &str, cmd: Option<&str>) -> Result<(), String> {
    let target = session;
    let mut args = vec![
        "new-window", "-t", target, "-n", window, "-c", cwd,
    ];
    let shell_cmd;
    if let Some(c) = cmd {
        let escaped = c.replace("'", "'\\''");
        shell_cmd = format!("bash -lc '{escaped}; exec bash -l'");
        args.push(&shell_cmd);
    }
    let output = tmux_base()
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run tmux: {e}"))?;
    if output.status.success() {
        ensure_server_config();
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub fn kill_server() {
    let _ = tmux_base()
        .args(["kill-server"])
        .output();
}

#[track_caller]
pub fn kill_session(session: &str) {
    let caller = std::panic::Location::caller();
    tlog!("[tmux] kill_session {session} (called from {}:{})", caller.file(), caller.line());
    let _ = tmux_base()
        .args(["kill-session", "-t", session])
        .output();
}

#[track_caller]
pub fn kill_window(session: &str, window: &str) {
    let caller = std::panic::Location::caller();
    let target = format!("{session}:{window}");
    tlog!("[tmux] kill_window {target} (called from {}:{})", caller.file(), caller.line());
    let _ = tmux_base()
        .args(["kill-window", "-t", &target])
        .output();
}






/// Check init pane status in a single tmux command.
/// Returns None if the window doesn't exist or the command fails.
/// Returns Some((dead, exit_status)) if successful.
/// Query the pane ID and window ID for a given session:window.
fn get_pane_and_window_id(session: &str, window: &str) -> Result<(String, String), String> {
    let target = format!("{session}:{window}");
    let output = tmux_base()
        .args(["list-panes", "-t", &target, "-F", "#{pane_id} #{window_id}"])
        .output()
        .map_err(|e| format!("Failed to query pane id: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()
        .ok_or_else(|| "No pane found".to_string())?;
    let parts: Vec<&str> = line.trim().splitn(2, ' ').collect();
    if parts.len() < 2 {
        return Err("Failed to parse pane and window ID".to_string());
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Set up a linked session for control-mode attach.
/// Creates the linked session via tmux subprocesses, queries the pane ID,
/// and returns (command, args, pane_id, link_session_name, window_id).
pub fn attach_args(session: &str, window: &str) -> Result<(String, Vec<String>, String, String, String), String> {
    let id = ATTACH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let link_name = format!("{session}--{window}-{id}");

    // Kill ALL stale linked sessions for this session+window.
    // Stale linked sessions from previous server runs keep their clients
    // "attached", constraining the pane size and preventing SIGWINCH.
    let prefix = format!("{session}--{window}-");
    for sess_name in list_sessions() {
        if sess_name.starts_with(&prefix) {
            tlog!("[tmux] attach_args: killing stale linked session {sess_name}");
            let _ = tmux_base()
                .args(["kill-session", "-t", &sess_name])
                .output();
        }
    }

    // Create linked session targeting the main session
    let output = tmux_base()
        .args(["new-session", "-d", "-s", &link_name, "-t", session])
        .output()
        .map_err(|e| format!("Failed to create linked session: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    // Select the desired window
    let target_window = format!("{link_name}:{window}");
    let _ = tmux_base()
        .args(["select-window", "-t", &target_window])
        .output();

    // Query pane ID and window ID from the main session (linked session shares its windows)
    let (pane_id, window_id) = get_pane_and_window_id(session, window)?;

    // Note: we don't set destroy-unattached here because the linked session
    // has no clients yet and would be destroyed immediately. Instead, the
    // terminal handler kills the linked session when the WebSocket closes.

    // Return the -C attach command (no bash wrapper needed)
    let link = link_name.clone();
    Ok((
        "tmux".to_string(),
        vec![
            "-L".to_string(), socket_name(),
            "-f".to_string(), "/dev/null".to_string(),
            "-C".to_string(),
            "attach".to_string(),
            "-t".to_string(), link_name,
        ],
        pane_id,
        link,
        window_id,
    ))
}

/// List all agentdispatch tmux sessions. Returns session names.
pub fn list_sessions() -> Vec<String> {
    let output = tmux_base()
        .args(["list-sessions", "-F", "#{session_name}"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        _ => Vec::new(),
    }
}

pub fn first_pane_cwd(session: &str) -> Option<String> {
    let output = tmux_base()
        .args(["list-panes", "-s", "-t", session, "-F", "#{window_name}\t#{pane_current_path}"])
        .output();
    if let Ok(o) = output {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let parts: Vec<&str> = line.splitn(2, '\t').collect();
                if parts.len() == 2 && parts[0] != "init" {
                    let path = parts[1].trim();
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    None
}

pub fn rename_window(session: &str, old_name: &str, new_name: &str) {
    let target = format!("{session}:{old_name}");
    tmux_base()
        .args(["rename-window", "-t", &target, new_name])
        .output()
        .ok();
}

pub fn list_windows(session: &str) -> Vec<String> {
    let output = tmux_base()
        .args(["list-windows", "-t", session, "-F", "#{window_name}"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Capture scrollback history + visible content of a pane with cursor position.
/// On reconnect this restores both the visible screen and scrollback so the
/// user can scroll up to see previous output.
pub fn capture_pane_with_cursor(pane_id: &str) -> Option<Vec<u8>> {
    // 1. Capture scrollback (lines above the visible area)
    let scrollback = tmux_base()
        .args(["capture-pane", "-t", pane_id, "-p", "-e", "-S", "-"])
        .output()
        .ok();

    // 2. Capture visible area
    let content = tmux_base()
        .args(["capture-pane", "-t", pane_id, "-p", "-e"])
        .output()
        .ok()?;
    if !content.status.success() {
        return None;
    }

    // 3. Capture cursor position
    let cursor = tmux_base()
        .args(["list-panes", "-t", pane_id, "-F", "#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_height}"])
        .output()
        .ok()?;

    Some(assemble_capture_output(
        scrollback.as_ref().filter(|o| o.status.success()).map(|o| o.stdout.as_slice()),
        &content.stdout,
        if cursor.status.success() { Some(&cursor.stdout) } else { None },
    ))
}

/// Pure assembly of the capture-pane output bytes we send to xterm.js.
/// Separated from `capture_pane_with_cursor` so the byte layout can be
/// tested without a live tmux process.
///
/// `cursor_info`, when present, is the raw stdout of `list-panes -F "cursor_x
/// cursor_y cursor_flag pane_height"`.
fn assemble_capture_output(
    scrollback_stdout: Option<&[u8]>,
    visible_stdout: &[u8],
    cursor_info: Option<&[u8]>,
) -> Vec<u8> {
    let mut result = Vec::new();

    // Parse pane height from cursor info (needed to split scrollback from visible)
    let pane_height = cursor_info
        .map(|c| String::from_utf8_lossy(c).to_string())
        .and_then(|s| s.lines().next().map(str::to_string))
        .and_then(|l| l.trim().split(' ').nth(3).map(str::to_string))
        .and_then(|h| h.parse::<usize>().ok())
        .unwrap_or(24);

    // Write scrollback lines as regular output (creates xterm.js scrollback).
    // capture-pane -S - returns scrollback + visible; we strip the visible
    // portion (last pane_height lines) since we paint that separately below.
    // Insert \x1b[m (full SGR reset) before each newline so the next line
    // starts with a clean graphic state — tmux's -e only emits attribute
    // changes on cell boundaries, so blank cells at line starts can inherit
    // stale SGR from the previous line (e.g. emacs's inverse mode line
    // bleeding into the line below it).
    if let Some(sb) = scrollback_stdout {
        if !sb.is_empty() {
            let mut all_stdout = sb;
            if all_stdout.last() == Some(&b'\n') {
                all_stdout = &all_stdout[..all_stdout.len() - 1];
            }
            let all_lines: Vec<&[u8]> = all_stdout.split(|&b| b == b'\n').collect();
            let sb_count = all_lines.len().saturating_sub(pane_height);
            if sb_count > 0 {
                for line in &all_lines[..sb_count] {
                    result.extend_from_slice(line);
                    result.extend_from_slice(b"\x1b[m\r\n");
                }
                // Push all scrollback lines off-screen by writing enough
                // blank newlines to fill the visible area.
                for _ in 0..pane_height {
                    result.extend_from_slice(b"\r\n");
                }
                // Erase the visible area (now contains blank lines)
                result.extend_from_slice(b"\x1b[2J");
            }
        }
    }

    // Write visible area with absolute positioning (existing behavior)
    let mut stdout = visible_stdout;
    if stdout.last() == Some(&b'\n') {
        stdout = &stdout[..stdout.len() - 1];
    }
    result.extend_from_slice(b"\x1b[H\x1b[m");
    for &byte in stdout {
        if byte == b'\n' {
            result.extend_from_slice(b"\x1b[m\r\n");
        } else {
            result.push(byte);
        }
    }
    // Reset once more so the cursor is positioned with clean SGR state —
    // otherwise the user's next keystroke inherits whatever attributes
    // were active at the end of the last captured cell.
    result.extend_from_slice(b"\x1b[m");

    // Position cursor
    if let Some(c) = cursor_info {
        let cursor_str = String::from_utf8_lossy(c);
        if let Some(line) = cursor_str.lines().next() {
            let parts: Vec<&str> = line.trim().split(' ').collect();
            if parts.len() >= 2 {
                if let (Ok(x), Ok(y)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                    result.extend_from_slice(format!("\x1b[{};{}H", y + 1, x + 1).as_bytes());
                }
                let visible = parts.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
                if visible == 0 {
                    result.extend_from_slice(b"\x1b[?25l");
                } else {
                    result.extend_from_slice(b"\x1b[?25h");
                }
            }
        }
    }

    result
}

/// Query whether a pane is currently in alternate screen mode.
pub fn pane_title(session: &str, window: &str) -> Option<String> {
    let target = format!("{session}:{window}");
    let output = tmux_base()
        .args(["list-panes", "-t", &target, "-F", "#{pane_title}"])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if title.is_empty() { None } else { Some(title) }
}

pub fn is_alternate_screen(session: &str, window: &str) -> bool {
    let target = format!("{session}:{window}");
    let output = tmux_base()
        .args(["list-panes", "-t", &target, "-F", "#{alternate_on}"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim() == "1"
        }
        _ => false,
    }
}

/// Check that tmux is available, and clean up any stale socket.
pub fn check_installed() -> bool {
    let ok = Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success());
    if ok {
        clean_stale_socket();
    }
    ok
}

/// Spawn a background thread that uses inotify to watch the parent of
/// the tmux socket file, and logs every create/delete/move/attrib event
/// that targets our filename. This catches external `rm`, renames from
/// another process, and the server's own exit — all with a timestamp,
/// so the log file tells us exactly when the socket went bad.
pub fn spawn_socket_watcher() {
    use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};

    let full = socket_path();
    let pathbuf = std::path::PathBuf::from(&full);
    let Some(parent) = pathbuf.parent().map(|p| p.to_path_buf()) else {
        tlog!("socket watcher: {full} has no parent dir, not watching");
        return;
    };
    let Some(name) = pathbuf.file_name().map(|n| n.to_owned()) else {
        tlog!("socket watcher: {full} has no file name, not watching");
        return;
    };

    // The parent dir (/tmp/tmux-<uid>) may not exist yet at startup if
    // no tmux command has run. Create it so inotify has something to
    // watch; tmux itself uses mode 0700 on this directory.
    if !parent.exists() {
        let _ = std::fs::create_dir_all(&parent);
    }

    std::thread::spawn(move || {
        loop {
            let Ok(inotify) = Inotify::init(InitFlags::empty()) else {
                tlog!("socket watcher: inotify init failed, giving up");
                return;
            };
            let flags = AddWatchFlags::IN_CREATE
                | AddWatchFlags::IN_DELETE
                | AddWatchFlags::IN_MOVED_TO
                | AddWatchFlags::IN_MOVED_FROM
                | AddWatchFlags::IN_ATTRIB;
            if let Err(e) = inotify.add_watch(&parent, flags) {
                tlog!("socket watcher: add_watch({}) failed: {e} — retrying in 30s", parent.display());
                std::thread::sleep(std::time::Duration::from_secs(30));
                continue;
            }
            tlog!("socket watcher: watching {} for {}", parent.display(), name.to_string_lossy());

            loop {
                let events = match inotify.read_events() {
                    Ok(ev) => ev,
                    Err(e) => {
                        tlog!("socket watcher: read_events failed: {e} — reinitialising");
                        break;
                    }
                };
                for ev in events {
                    if ev.name.as_deref() == Some(name.as_os_str()) {
                        let probe = probe_socket(&full);
                        tlog!(
                            "socket watcher: {} on {} mask={:?} → probe={:?}",
                            parent.display(),
                            name.to_string_lossy(),
                            ev.mask,
                            probe
                        );
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

/// Periodic sanity check: log whenever the socket probe result changes.
/// Runs forever on the actix runtime.
pub async fn run_health_check() {
    let path = socket_path();
    let mut prev: Option<SocketProbe> = None;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        interval.tick().await;
        let now = probe_socket(&path);
        if prev.as_ref() != Some(&now) {
            tlog!("socket health: state {prev:?} -> {now:?}");
            prev = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Pure assembly tests (no tmux required) --

    // Cursor info format: "cursor_x cursor_y cursor_flag pane_height"
    fn cursor(x: u32, y: u32, visible: u32, h: usize) -> Vec<u8> {
        format!("{x} {y} {visible} {h}\n").into_bytes()
    }

    #[test]
    fn test_assemble_resets_sgr_between_visible_lines() {
        // Simulate tmux capturing an emacs-like screen: two normal lines, a
        // fully-inverse status line, and a blank minibuffer line. Tmux's -e
        // emits \x1b[7m when entering inverse but may not emit an explicit
        // reset on line transitions. We need \x1b[m inserted before each
        // \r\n so the next line can't inherit the inverse attribute.
        let visible = b"line above\n\x1b[7mstatus line\n\nafter blank\n";
        let out = assemble_capture_output(None, visible, Some(&cursor(0, 0, 1, 4)));
        let s = String::from_utf8_lossy(&out);

        // Every captured-line newline must be preceded by a SGR reset.
        assert!(s.contains("line above\x1b[m\r\n"), "missing reset after 'line above': {s:?}");
        assert!(s.contains("status line\x1b[m\r\n"), "missing reset after status line: {s:?}");
        // The blank line between status and 'after blank' must also reset
        // (this is the emacs minibuffer case the user reported).
        assert!(s.contains("\x1b[m\r\n\x1b[m\r\nafter blank"),
            "missing resets around blank line: {s:?}");

        // Start of visible area is reset too, so the screen opens clean.
        assert!(s.contains("\x1b[H\x1b[m"), "missing home+reset at start: {s:?}");

        // End of visible area must reset before cursor positioning so the
        // user's next keystroke doesn't inherit stale SGR.
        let pos = s.find("\x1b[").and_then(|_| {
            // Find the final reset that precedes the cursor-position code.
            let cursor_move = s.rfind("\x1b[1;1H")?;
            let reset = s[..cursor_move].rfind("\x1b[m")?;
            Some((reset, cursor_move))
        });
        assert!(pos.is_some(), "reset should come right before cursor positioning: {s:?}");
    }

    #[test]
    fn test_assemble_scrollback_lines_reset_too() {
        // Scrollback lines go through the same accumulator — verify they
        // also get SGR resets so scrollback rows don't inherit stale attrs.
        // 4 lines total, pane_height=2 → first 2 are scrollback.
        let sb = b"sb1\n\x1b[7msb2-inverse\nvis1\nvis2\n";
        let vis = b"vis1\nvis2\n";
        let out = assemble_capture_output(Some(sb), vis, Some(&cursor(0, 0, 1, 2)));
        let s = String::from_utf8_lossy(&out);

        assert!(s.contains("sb1\x1b[m\r\n"), "scrollback line 1 missing reset: {s:?}");
        assert!(s.contains("sb2-inverse\x1b[m\r\n"), "scrollback inverse line missing reset: {s:?}");
    }

    #[test]
    fn test_assemble_cursor_position() {
        let visible = b"hello\nworld\n";
        let out = assemble_capture_output(None, visible, Some(&cursor(3, 1, 1, 2)));
        let s = String::from_utf8_lossy(&out);
        // cursor_x=3 cursor_y=1 -> \x1b[2;4H (1-based)
        assert!(s.contains("\x1b[2;4H"), "expected cursor positioning: {s:?}");
        // visible=1 -> show cursor
        assert!(s.contains("\x1b[?25h"), "expected show-cursor: {s:?}");
    }

    #[test]
    fn test_assemble_hidden_cursor() {
        let out = assemble_capture_output(None, b"x\n", Some(&cursor(0, 0, 0, 1)));
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("\x1b[?25l"), "expected hide-cursor: {s:?}");
    }

    // -- Integration tests (require tmux) --
    // These use a separate socket ("agentdispatch-test") to avoid
    // interfering with the E2E server which uses the main socket.

    const TEST_SOCKET: &str = "agentdispatch-test";

    fn test_tmux_base() -> Command {
        let mut cmd = Command::new("tmux");
        cmd.args(["-L", TEST_SOCKET, "-f", "/dev/null"]);
        cmd.env_remove("TMUX");
        cmd.env("TERM", "xterm-256color");
        cmd
    }

    fn tmux_available() -> bool {
        Command::new("tmux").arg("-V").output().is_ok_and(|o| o.status.success())
    }

    fn test_kill_session(session: &str) {
        let _ = test_tmux_base().args(["kill-session", "-t", session]).output();
    }

    fn test_has_session(session: &str) -> bool {
        test_tmux_base().args(["has-session", "-t", session]).output().is_ok_and(|o| o.status.success())
    }

    fn test_has_window(session: &str, window: &str) -> bool {
        let target = format!("{session}:{window}");
        test_tmux_base().args(["select-window", "-t", &target]).output().is_ok_and(|o| o.status.success())
    }

    fn test_new_session(session: &str, window: &str) {
        let output = test_tmux_base()
            .args(["new-session", "-d", "-s", session, "-n", window, "-c", "/tmp"])
            .output()
            .expect("tmux new-session failed");
        assert!(output.status.success(), "new-session failed: {}", String::from_utf8_lossy(&output.stderr));
        let _ = test_tmux_base().args(["set-option", "-g", "history-limit", "10000"]).output();
    }

    fn test_new_window(session: &str, window: &str) {
        let output = test_tmux_base()
            .args(["new-window", "-t", session, "-n", window, "-c", "/tmp"])
            .output()
            .expect("tmux new-window failed");
        assert!(output.status.success(), "new-window failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    fn test_kill_window(session: &str, window: &str) {
        let target = format!("{session}:{window}");
        let _ = test_tmux_base().args(["kill-window", "-t", &target]).output();
    }

    fn test_get_option(option: &str) -> Option<String> {
        let output = test_tmux_base().args(["show-option", "-gv", option]).output().ok()?;
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        }
    }

    fn test_list_sessions() -> Vec<String> {
        let output = test_tmux_base().args(["list-sessions", "-F", "#{session_name}"]).output();
        match output {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
            }
            _ => Vec::new(),
        }
    }

    #[test]
    fn test_capture_pane_with_cursor() {
        if !tmux_available() { return; }
        let session = "test-capture";
        test_kill_session(session);
        test_new_session(session, "win0");

        // Send some output to the pane
        let _ = test_tmux_base()
            .args(["send-keys", "-t", &format!("{session}:win0"), "echo CAPTURE_TEST", "Enter"])
            .output();
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Get pane ID (using test socket, not main socket — but capture_pane_with_cursor
        // uses the main socket. So we test the function indirectly by verifying
        // the return format is correct on the main socket.)
        // For a proper test, query from the test socket:
        let output = test_tmux_base()
            .args(["list-panes", "-t", &format!("{session}:win0"), "-F", "#{pane_id}"])
            .output()
            .unwrap();
        let pane_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // capture_pane_with_cursor uses tmux_base (main socket), not test socket.
        // So we can't use it directly here. Instead test the capture logic manually:
        let capture = test_tmux_base()
            .args(["capture-pane", "-t", &pane_id, "-p", "-e", "-S", "-"])
            .output()
            .unwrap();
        assert!(capture.status.success());
        let content = String::from_utf8_lossy(&capture.stdout);
        assert!(content.contains("CAPTURE_TEST"), "capture should contain our text: {content}");

        test_kill_session(session);
    }

    #[test]
    fn test_server_config() {
        if !tmux_available() { return; }
        let session = "test-cfg";
        test_kill_session(session);
        test_new_session(session, "win0");
        assert_eq!(test_get_option("history-limit").as_deref(), Some("10000"));
        test_kill_session(session);
    }

    #[test]
    fn test_session_and_window_lifecycle() {
        if !tmux_available() { return; }
        let session = "test-lifecycle";
        test_kill_session(session);

        assert!(!test_has_session(session));

        test_new_session(session, "win0");
        assert!(test_has_session(session));
        assert!(test_has_window(session, "win0"));
        assert!(!test_has_window(session, "win1"));

        test_new_window(session, "win1");
        assert!(test_has_window(session, "win1"));

        test_kill_window(session, "win1");
        assert!(!test_has_window(session, "win1"));
        assert!(test_has_session(session));

        test_kill_session(session);
        assert!(!test_has_session(session));
    }

    #[test]
    fn test_list_sessions_includes_created() {
        if !tmux_available() { return; }
        let session = "test-list-sess";
        test_kill_session(session);

        test_new_session(session, "win0");
        let sessions = test_list_sessions();
        assert!(sessions.contains(&session.to_string()),
            "list_sessions should include {session}, got: {sessions:?}");

        test_kill_session(session);
    }

    /// Helper: build a unique temp path inside /tmp so probe tests don't
    /// collide with each other or with the real tmux socket.
    fn scratch_path(tag: &str) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let ns = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let pid = std::process::id();
        format!("/tmp/agentdispatch-probe-{tag}-{pid}-{ns}")
    }

    #[test]
    fn test_probe_socket_missing() {
        let p = scratch_path("missing");
        let _ = std::fs::remove_file(&p);
        assert_eq!(probe_socket(&p), SocketProbe::Missing);
    }

    #[test]
    fn test_probe_socket_live_listener() {
        let p = scratch_path("live");
        let _ = std::fs::remove_file(&p);
        let _listener = std::os::unix::net::UnixListener::bind(&p)
            .expect("bind unix listener");
        assert_eq!(probe_socket(&p), SocketProbe::Live);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn test_probe_socket_stale_after_listener_drops() {
        // Bind a listener, drop it (which closes the fd but leaves the
        // socket file on disk — exactly the stale-socket scenario).
        let p = scratch_path("stale");
        let _ = std::fs::remove_file(&p);
        {
            let listener = std::os::unix::net::UnixListener::bind(&p)
                .expect("bind unix listener");
            drop(listener);
        }
        assert_eq!(probe_socket(&p), SocketProbe::Stale);
        let _ = std::fs::remove_file(&p);
    }

    /// End-to-end check that inotify actually sees a delete+recreate
    /// of the watched filename — the exact pattern the watcher is
    /// meant to catch.
    #[test]
    fn test_inotify_sees_delete_and_recreate() {
        use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
        let dir = std::env::temp_dir().join(format!(
            "agentdispatch-itest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let target = dir.join("sock");
        std::fs::write(&target, b"").expect("write target");

        let inotify = Inotify::init(InitFlags::IN_NONBLOCK).expect("inotify init");
        inotify
            .add_watch(&dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_DELETE)
            .expect("add_watch");

        std::fs::remove_file(&target).expect("delete");
        std::fs::write(&target, b"").expect("recreate");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_delete = false;
        let mut saw_create = false;
        while std::time::Instant::now() < deadline && !(saw_delete && saw_create) {
            match inotify.read_events() {
                Ok(events) => {
                    for ev in events {
                        if ev.name.as_deref() == Some(target.file_name().unwrap()) {
                            if ev.mask.contains(AddWatchFlags::IN_DELETE) {
                                saw_delete = true;
                            }
                            if ev.mask.contains(AddWatchFlags::IN_CREATE) {
                                saw_create = true;
                            }
                        }
                    }
                }
                Err(nix::errno::Errno::EAGAIN) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("read_events: {e}"),
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
        assert!(saw_delete, "expected IN_DELETE for {}", target.display());
        assert!(saw_create, "expected IN_CREATE for {}", target.display());
    }
}
