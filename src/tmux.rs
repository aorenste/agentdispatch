use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

const SOCKET: &str = "agentdispatch";
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
                    let socket_path = format!("/tmp/tmux-{uid}/{SOCKET}");
                    let _ = std::fs::remove_file(&socket_path);
                    eprintln!("Removed stale tmux socket: {socket_path}");
                }
            }
        }
        Err(_) => {}
        _ => {}
    }
}

fn tmux_base() -> Command {
    let mut cmd = Command::new("tmux");
    cmd.args(["-L", SOCKET, "-f", "/dev/null"]);
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

/// Query the pane ID for a given session:window.
fn get_pane_id(session: &str, window: &str) -> Result<String, String> {
    let target = format!("{session}:{window}");
    let output = tmux_base()
        .args(["list-panes", "-t", &target, "-F", "#{pane_id}"])
        .output()
        .map_err(|e| format!("Failed to query pane id: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No pane found".to_string())
}

/// Set up a linked session for control-mode attach.
/// Creates the linked session via tmux subprocesses, queries the pane ID,
/// and returns (command, args, pane_id, link_session_name).
pub fn attach_args(session: &str, window: &str) -> Result<(String, Vec<String>, String, String), String> {
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

    // Query pane ID from the main session (linked session shares its windows)
    let pane_id = get_pane_id(session, window)?;

    // Note: we don't set destroy-unattached here because the linked session
    // has no clients yet and would be destroyed immediately. Instead, the
    // terminal handler kills the linked session when the WebSocket closes.

    // Return the -C attach command (no bash wrapper needed)
    let link = link_name.clone();
    Ok((
        "tmux".to_string(),
        vec![
            "-L".to_string(), SOCKET.to_string(),
            "-f".to_string(), "/dev/null".to_string(),
            "-C".to_string(),
            "attach".to_string(),
            "-t".to_string(), link_name,
        ],
        pane_id,
        link,
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
