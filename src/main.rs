#![deny(warnings)]

/// Global log file handle. Initialized by `init_logging` at startup.
/// `tlog!` writes to this AND stderr so diagnostics survive across runs.
pub static LOG_FILE: std::sync::OnceLock<std::sync::Mutex<std::fs::File>> =
    std::sync::OnceLock::new();

/// Like `eprintln!` but prepends a timestamp. Writes to stderr and, if
/// `LOG_FILE` has been initialized, to the log file as well.
macro_rules! tlog {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        let h = (secs / 3600) % 24;
        let m = (secs / 60) % 60;
        let s = secs % 60;
        let ms = now.subsec_millis();
        // One preformatted line so every sink writes identical bytes at once.
        let line = format!("{h:02}:{m:02}:{s:02}.{ms:03} {}\n", format_args!($($arg)*));
        // Mirror to stderr WITHOUT blocking the caller. A stalled console (full
        // pty buffer, paused/scrolled terminal, dead ssh) must never wedge the
        // request path — see `mirror_to_stderr` / `AsyncLineWriter`.
        $crate::mirror_to_stderr(&line);
        // The durable log file is a regular file, so its write can't block on a
        // stalled terminal; keep it synchronous so the log stays crash-complete.
        if let Some(f) = $crate::LOG_FILE.get() {
            if let Ok(mut f) = f.lock() {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }};
}

/// Bounded queue capacity for the async stderr mirror. Lines beyond this are
/// dropped while the terminal is stalled (the durable file log is unaffected).
const STDERR_LOG_CAP: usize = 4096;

/// Background stderr mirror. Installed by `init_logging`; until then
/// `mirror_to_stderr` falls back to a direct (startup-only) write.
static STDERR_WRITER: std::sync::OnceLock<AsyncLineWriter> = std::sync::OnceLock::new();

/// Drains preformatted log lines to a sink on a dedicated thread. `emit` is
/// non-blocking (it drops on a full queue), so a sink that stalls — e.g. a
/// terminal whose pty output buffer is full and isn't being drained — can only
/// ever block this one thread, never the threads producing log lines.
///
/// This is the fix for the whole-server wedge: `tlog!` used to write to
/// `std::io::Stderr` under its process-global lock, so a stalled console froze
/// that lock and every concurrent `tlog!` — including the `tmux` calls that gate
/// terminal attach (`attach_args`, `kill_session`) — hung forever, making every
/// pane report "Connection failed" until the server was restarted.
struct AsyncLineWriter {
    tx: std::sync::mpsc::SyncSender<Vec<u8>>,
}

impl AsyncLineWriter {
    /// Spawn the writer thread. `cap` bounds how many lines may queue while the
    /// sink is stalled before further lines are dropped.
    fn new<W>(mut sink: W, cap: usize) -> Self
    where
        W: std::io::Write + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(cap);
        std::thread::Builder::new()
            .name("log-stderr".to_string())
            .spawn(move || {
                // Loops until every sender drops. A stalled `write_all` blocks
                // only this thread; producers keep running (their lines queue,
                // then drop once `cap` is reached).
                for line in rx {
                    let _ = sink.write_all(&line);
                    let _ = sink.flush();
                }
            })
            .expect("failed to spawn log-stderr thread");
        Self { tx }
    }

    /// Enqueue a line without blocking; drop it if the queue is full.
    fn emit(&self, line: &[u8]) {
        let _ = self.tx.try_send(line.to_vec());
    }
}

/// Hand a preformatted log line to the background stderr writer without
/// blocking. Before `init_logging` runs (early startup / unit tests) there is
/// no writer thread yet; volume is tiny and there's no concurrency then, so a
/// direct write is safe.
pub(crate) fn mirror_to_stderr(line: &str) {
    if let Some(writer) = STDERR_WRITER.get() {
        writer.emit(line.as_bytes());
    } else {
        use std::io::Write as _;
        let _ = std::io::stderr().write_all(line.as_bytes());
    }
}

mod db;
mod paths;
mod projects;
mod terminal;
mod tmux;
mod tmux_cc;
mod web;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Set up logging: start the background stderr mirror thread, open the log file
/// in append mode, and install it as the durable sink. A header with PID and
/// startup timestamp is written so separate runs are easy to tell apart.
///
/// The stderr mirror runs on its own thread so a stalled console can never wedge
/// the callers of `tlog!` (see `AsyncLineWriter`).
fn init_logging(path: &std::path::Path) {
    use std::io::Write as _;

    // Install the async stderr mirror first so even startup diagnostics use the
    // non-blocking path.
    let _ = STDERR_WRITER.set(AsyncLineWriter::new(std::io::stderr(), STDERR_LOG_CAP));

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to open log file {}: {e}", path.display());
            return;
        }
    };
    let pid = std::process::id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let _ = writeln!(
        file,
        "\n===== agentdispatch start pid={pid} epoch={}.{:03} =====",
        now.as_secs(),
        now.subsec_millis()
    );
    let _ = LOG_FILE.set(std::sync::Mutex::new(file));
}

use actix_web::{App, HttpServer};
use clap::Parser;

/// The server listens on loopback only. There is no auth, so anything that can
/// reach the port gets a shell — keep it that way unless authentication lands
/// first. (Token auth, TLS and interface binding were prototyped and removed;
/// see the commit that stripped them for the history.)
const BIND_ADDR: &str = "127.0.0.1";

#[derive(Parser)]
#[command(name = "agentdispatch", about = "Agent dispatch server")]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 8915)]
    port: u16,

    /// Path to SQLite database file
    #[arg(long, default_value = "agentdispatch.db")]
    db: PathBuf,

    /// Path to log file (stderr is mirrored here). Defaults to the db path
    /// with extension replaced by ".log".
    #[arg(long)]
    log: Option<PathBuf>,

    /// Disable tmux (use direct shell for terminals)
    #[arg(long)]
    no_tmux: bool,

    /// Kill tmux server and delete database before starting
    #[arg(long)]
    reset: bool,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();

    let use_tmux = !args.no_tmux;

    let log_path = args.log.clone().unwrap_or_else(|| {
        let mut p = args.db.clone();
        p.set_extension("log");
        p
    });
    init_logging(&log_path);
    tlog!("agentdispatch starting (pid={}, log={})", std::process::id(), log_path.display());

    // Bind the port FIRST — before --reset, the tmux sweep, or anything else
    // that mutates shared state. The port is our mutual-exclusion lock: if
    // another server is already running we must fail here having touched
    // nothing. Doing the tmux cleanup first meant a doomed second instance
    // (e.g. `cargo run` while the real server is up) would kill every
    // workspace's live control-mode sessions on its way to "address already in
    // use". See e2e/second-instance.test.js.
    let listener = match std::net::TcpListener::bind((BIND_ADDR, args.port)) {
        Ok(l) => l,
        Err(e) => {
            let hint = if e.kind() == std::io::ErrorKind::AddrInUse {
                " (another agentdispatch is probably already running — nothing was changed)"
            } else {
                ""
            };
            tlog!("Error: cannot bind {BIND_ADDR}:{}: {e}{hint}", args.port);
            eprintln!("agentdispatch: cannot bind {BIND_ADDR}:{}: {e}{hint}", args.port);
            std::process::exit(1);
        }
    };

    if args.reset {
        tlog!("Resetting: killing tmux server and deleting database");
        tmux::kill_server();
        let _ = std::fs::remove_file(&args.db);
        // Also remove WAL/SHM files
        let mut wal = args.db.clone();
        wal.set_extension("db-wal");
        let _ = std::fs::remove_file(&wal);
        let mut shm = args.db.clone();
        shm.set_extension("db-shm");
        let _ = std::fs::remove_file(&shm);
    }

    if use_tmux {
        if !tmux::check_installed() {
            tlog!("Error: tmux is required but not found in PATH (use --no-tmux to disable)");
            std::process::exit(1);
        }
        tmux::log_startup_diagnostics();
        tmux::spawn_socket_watcher();
        actix_web::rt::spawn(tmux::run_health_check());
    }

    let conn = db::init_db(&args.db);
    let db_arc = Arc::new(Mutex::new(conn));

    // Clean up stale linked sessions (ws-N--window-M) from previous server runs.
    // These are control-mode clients that get recreated on WebSocket reconnect.
    // Never kill main sessions (ws-N) — they contain the user's work.
    if use_tmux {
        for session_name in tmux::list_sessions() {
            if let Some(id_str) = session_name.strip_prefix("ws-") {
                if id_str.contains("--") {
                    tlog!("Killing stale linked session: {session_name}");
                    tmux::kill_session(&session_name);
                }
            }
        }
    }

    let (tx, _) = tokio::sync::broadcast::channel::<web::UpdateBatch>(64);
    let (pane_title_tx, _) = tokio::sync::broadcast::channel::<terminal::PaneTitleUpdate>(256);

    let build_hash = web::build_hash();
    tlog!("Build hash: {}", build_hash);

    println!("http://localhost:{}", args.port);

    // Publish our port so local tools (ad-title, ad-ws-name) can find us. It
    // lives in $XDG_RUNTIME_DIR (tmpfs, per-user, machine-local) so it can't
    // collide across machines or be picked up by dotsync. Tests set
    // AGENTDISPATCH_PORT_FILE to an isolated path (see paths::port_file).
    if let Some(p) = paths::port_file() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, args.port.to_string());
    }

    let tx_data = actix_web::web::Data::new(tx);
    let pane_title_tx_data = actix_web::web::Data::new(pane_title_tx);
    let hash_data = actix_web::web::Data::new(build_hash);
    let db_data = actix_web::web::Data::new(db_arc);
    let tmux_data = actix_web::web::Data::new(use_tmux);
    let server = HttpServer::new(move || {
        App::new()
            .app_data(tx_data.clone())
            .app_data(pane_title_tx_data.clone())
            .app_data(hash_data.clone())
            .app_data(db_data.clone())
            .app_data(tmux_data.clone())
            .service(web::icon)
            .service(web::app_js)
            .service(web::index)
            .service(web::events)
            .service(terminal::ws_terminal)
            .service(projects::create_workspace)
            .service(projects::list_workspaces)
            .service(projects::create_category)
            .service(projects::rename_category)
            .service(projects::delete_category)
            .service(projects::reorder_categories)
            .service(projects::toggle_category)
            .service(projects::set_workspace_category)
            .service(projects::reorder_workspaces)
            .service(projects::rename_workspace)
            .service(projects::update_workspace_notes)
            .service(projects::rename_workspace_by_pane)
            .service(projects::rename_tab_by_pane)
            .service(projects::set_pane_title_by_pane)
            .service(projects::recreate_workspace)
            .service(projects::recreate_tab)
            .service(projects::delete_workspace)
            .service(projects::reorder_tabs)
            .service(projects::create_tab)
            .service(projects::update_tab)
            .service(projects::delete_tab)
            .service(projects::client_log)
    });

    server.listen(listener)?.run().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    /// A sink whose `write` blocks until explicitly released — models a terminal
    /// whose pty output buffer is full and is not being drained (exactly the
    /// production wedge: fd 2 pointed at a stalled console).
    struct StalledSink {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for StalledSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (lock, cvar) = &*self.gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Regression test for the whole-server wedge. When the stderr sink stalls,
    /// enqueuing a log line must NOT block the caller. Before the fix, `tlog!`
    /// wrote to `std::io::Stderr` under its process-global lock, so a stalled
    /// terminal froze that lock and every concurrent `tlog!` hung — including the
    /// tmux calls (`attach_args`, `kill_session`) that gate terminal attach, so
    /// every pane reported "Connection failed" until a restart.
    ///
    /// With the async writer, `emit` drops on a full queue instead of blocking,
    /// so the producer finishes promptly even though the sink is wedged. If
    /// `emit` ever blocks again, the producer never signals done and this test
    /// fails on the timeout.
    #[test]
    fn test_emit_never_blocks_when_sink_stalls() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        // Tiny queue so it fills almost immediately once the sink stalls.
        let writer = Arc::new(AsyncLineWriter::new(
            StalledSink { gate: gate.clone() },
            4,
        ));

        // The writer thread grabs the first line and blocks in the stalled sink;
        // the bounded queue then fills and stays full. Every `emit` must still
        // return promptly. Run them from a worker thread so a hang can't wedge
        // the test thread — we detect it via the timeout below.
        let w = writer.clone();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            for i in 0..1000 {
                w.emit(format!("line {i}\n").as_bytes());
            }
            let _ = done_tx.send(());
        });

        let outcome = done_rx.recv_timeout(Duration::from_secs(5));

        // Release the sink so the writer thread can drain and exit cleanly.
        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }

        assert!(
            outcome.is_ok(),
            "emit() blocked on a stalled stderr sink — logging would wedge \
             request handlers (the terminal-attach path calls tlog!)"
        );
    }
}
