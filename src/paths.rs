//! XDG Base Directory resolution for agentdispatch's on-disk files.
//!
//! - **config** (`peers.json`, `token`) → `$XDG_CONFIG_HOME/agentdispatch`
//!   (default `~/.config/agentdispatch`). This is the only thing you dotsync
//!   across machines.
//! - **runtime** (`port`) → `$XDG_RUNTIME_DIR/agentdispatch` (tmpfs, per-user,
//!   machine-local, cleared on reboot). Never synced, can't collide across
//!   machines — no dotsync exclude needed.
//!
//! The legacy flat `~/.agentdispatch/<name>` layout is still read as a fallback
//! so existing setups keep working during the transition.

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

/// `$XDG_CONFIG_HOME/agentdispatch` (default `~/.config/agentdispatch`).
pub fn config_dir() -> Option<PathBuf> {
    env_dir("XDG_CONFIG_HOME")
        .or_else(|| home().map(|h| h.join(".config")))
        .map(|d| d.join("agentdispatch"))
}

/// Legacy pre-XDG layout (`~/.agentdispatch`), read-only fallback.
fn legacy_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".agentdispatch"))
}

/// Read a config file (`token`, `peers.json`) from the XDG config dir, falling
/// back to the legacy `~/.agentdispatch/<name>`. Returns its contents if found.
pub fn read_config(name: &str) -> Option<String> {
    [config_dir(), legacy_dir()]
        .into_iter()
        .flatten()
        .find_map(|dir| std::fs::read_to_string(dir.join(name)).ok())
}

/// Where the running server publishes its port for local tools (ad-title,
/// ad-ws-name). `$AGENTDISPATCH_PORT_FILE` overrides (used by tests); otherwise
/// `$XDG_RUNTIME_DIR/agentdispatch/port`, falling back to
/// `$XDG_STATE_HOME/agentdispatch/port` (default `~/.local/state/...`) when no
/// runtime dir exists.
pub fn port_file() -> Option<PathBuf> {
    if let Some(p) = env_dir("AGENTDISPATCH_PORT_FILE") {
        return Some(p);
    }
    if let Some(rt) = env_dir("XDG_RUNTIME_DIR") {
        return Some(rt.join("agentdispatch").join("port"));
    }
    env_dir("XDG_STATE_HOME")
        .or_else(|| home().map(|h| h.join(".local").join("state")))
        .map(|d| d.join("agentdispatch").join("port"))
}
