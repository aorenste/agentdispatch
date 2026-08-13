//! XDG Base Directory resolution for agentdispatch's on-disk files.
//!
//! Persistent data (`agentdispatch.db`) goes in
//! `$XDG_DATA_HOME/agentdispatch` (default `~/.local/share/agentdispatch`).
//! Runtime state (`port` and `pid`) goes in `$XDG_RUNTIME_DIR/agentdispatch`
//! (tmpfs, per-user, machine-local, cleared on reboot), with an XDG state-dir
//! fallback when no runtime directory is available.
//!
//! There is no config dir at present: the files that would have lived in
//! `$XDG_CONFIG_HOME/agentdispatch` (`token`, `peers.json`) belonged to the
//! network-exposure work that was removed. Add it back alongside that.

use std::path::PathBuf;

fn non_empty(p: PathBuf) -> Option<PathBuf> {
    (!p.as_os_str().is_empty()).then_some(p)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).and_then(non_empty)
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).and_then(non_empty)
}

/// Persistent application data directory. This is deliberately separate from
/// runtime metadata and from laptop-specific connection configuration.
pub fn data_dir() -> Option<PathBuf> {
    env_dir("XDG_DATA_HOME")
        .or_else(|| home().map(|h| h.join(".local").join("share")))
        .map(|d| d.join("agentdispatch"))
}

/// Default SQLite database path. The relative fallback is retained only for
/// environments that provide neither `XDG_DATA_HOME` nor `HOME`.
pub fn database_file() -> PathBuf {
    data_dir()
        .map(|dir| dir.join("agentdispatch.db"))
        .unwrap_or_else(|| PathBuf::from("agentdispatch.db"))
}

fn runtime_file(override_var: &str, name: &str) -> Option<PathBuf> {
    if let Some(p) = env_dir(override_var) {
        return Some(p);
    }
    if let Some(rt) = env_dir("XDG_RUNTIME_DIR") {
        return Some(rt.join("agentdispatch").join(name));
    }
    env_dir("XDG_STATE_HOME")
        .or_else(|| home().map(|h| h.join(".local").join("state")))
        .map(|d| d.join("agentdispatch").join(name))
}

/// Where the running server publishes its port for local tools (ad-title,
/// ad-ws-name). `$AGENTDISPATCH_PORT_FILE` overrides (used by tests); otherwise
/// `$XDG_RUNTIME_DIR/agentdispatch/port`, falling back to
/// `$XDG_STATE_HOME/agentdispatch/port` (default `~/.local/state/...`) when no
/// runtime dir exists.
pub fn port_file() -> Option<PathBuf> {
    runtime_file("AGENTDISPATCH_PORT_FILE", "port")
}

/// Where the running server publishes its process ID. The location follows the
/// same runtime/state fallback as [`port_file`].
pub fn pid_file() -> Option<PathBuf> {
    runtime_file("AGENTDISPATCH_PID_FILE", "pid")
}
