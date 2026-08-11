//! XDG Base Directory resolution for agentdispatch's on-disk files.
//!
//! Only runtime state lives here today: the `port` file goes in
//! `$XDG_RUNTIME_DIR/agentdispatch` (tmpfs, per-user, machine-local, cleared on
//! reboot). That keeps it out of `$HOME`, so it can neither collide across
//! machines nor be swept up by dotsync — no exclude rule needed.
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
