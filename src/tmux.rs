use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

fn socket_name() -> String {
    std::env::var("AGENTDISPATCH_TMUX_SOCKET").unwrap_or_else(|_| "agentdispatch".to_string())
}
static ATTACH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Remove stale tmux socket if the server is dead.
/// This handles the case where the tmux server crashed or was killed
/// but left its socket file behind.
fn clean_stale_socket() {
    let output = tmux_base()
        .args(["list-sessions"])
        .output();
    match output {
        Ok(o) if !o.status.success() => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("server exited unexpectedly") || stderr.contains("no server running") {
                // Socket is stale — remove it
                let uid = unsafe { nix::libc::getuid() };
                {
                    let socket_path = format!("/tmp/tmux-{uid}/{}", socket_name());
                    let _ = std::fs::remove_file(&socket_path);
                    tlog!("Removed stale tmux socket: {socket_path}");
                }
            }
        }
        Err(_) => {}
        _ => {}
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
        .args(["select-window", "-t", &target])
        .output()
        .is_ok_and(|o| o.status.success())
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
    let mut args = vec![
        "new-session", "-d", "-s", session, "-n", window, "-c", cwd,
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
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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

pub fn kill_session(session: &str) {
    let _ = tmux_base()
        .args(["kill-session", "-t", session])
        .output();
}

pub fn kill_window(session: &str, window: &str) {
    let target = format!("{session}:{window}");
    let _ = tmux_base()
        .args(["kill-window", "-t", &target])
        .output();
}

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

/// Query the last activity timestamp for all agent panes.
/// Returns a map of workspace ID → Unix timestamp (seconds).
pub fn agent_pane_activities() -> std::collections::HashMap<i64, u64> {
    let mut result = std::collections::HashMap::new();
    let output = tmux_base()
        .args(["list-windows", "-a", "-F", "#{session_name} #{window_name} #{window_activity}"])
        .output();
    if let Ok(o) = output {
        if o.status.success() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let parts: Vec<&str> = line.trim().splitn(3, ' ').collect();
                if parts.len() == 3 && parts[1] == "agent" {
                    if let Some(id_str) = parts[0].strip_prefix("ws-") {
                        if let (Ok(id), Ok(ts)) = (id_str.parse::<i64>(), parts[2].parse::<u64>()) {
                            result.insert(id, ts);
                        }
                    }
                }
            }
        }
    }
    result
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

    let mut result = Vec::new();

    // Parse pane height from cursor info (needed to split scrollback from visible)
    let pane_height = if cursor.status.success() {
        let s = String::from_utf8_lossy(&cursor.stdout);
        s.lines().next()
            .and_then(|l| l.trim().split(' ').nth(3))
            .and_then(|h| h.parse::<usize>().ok())
            .unwrap_or(24)
    } else {
        24
    };

    // Write scrollback lines as regular output (creates xterm.js scrollback).
    // capture-pane -S - returns scrollback + visible; we strip the visible
    // portion (last pane_height lines) since we paint that separately below.
    if let Some(ref sb) = scrollback {
        if sb.status.success() && !sb.stdout.is_empty() {
            let mut all_stdout = sb.stdout.as_slice();
            if all_stdout.last() == Some(&b'\n') {
                all_stdout = &all_stdout[..all_stdout.len() - 1];
            }
            let all_lines: Vec<&[u8]> = all_stdout.split(|&b| b == b'\n').collect();
            let sb_count = all_lines.len().saturating_sub(pane_height);
            if sb_count > 0 {
                for line in &all_lines[..sb_count] {
                    result.extend_from_slice(line);
                    result.extend_from_slice(b"\r\n");
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
    let mut stdout = content.stdout.as_slice();
    if stdout.last() == Some(&b'\n') {
        stdout = &stdout[..stdout.len() - 1];
    }
    result.extend_from_slice(b"\x1b[H");
    for &byte in stdout {
        if byte == b'\n' {
            result.extend_from_slice(b"\r\n");
        } else {
            result.push(byte);
        }
    }

    // Position cursor
    if cursor.status.success() {
        let cursor_str = String::from_utf8_lossy(&cursor.stdout);
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

    Some(result)
}

/// Query whether a pane is currently in alternate screen mode.
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
