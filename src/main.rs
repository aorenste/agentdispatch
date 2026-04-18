#![deny(warnings)]

/// Like `eprintln!` but prepends a timestamp.
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
        let mut stderr = std::io::stderr().lock();
        let _ = write!(stderr, "{h:02}:{m:02}:{s:02}.{ms:03} ");
        let _ = writeln!(stderr, $($arg)*);
    }};
}

mod db;
mod projects;
mod terminal;
mod tmux;
mod tmux_cc;
mod web;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use actix_web::{App, HttpServer};
use clap::Parser;

#[derive(Parser)]
#[command(name = "agentdispatch", about = "Agent dispatch server")]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 8915)]
    port: u16,

    /// Path to SQLite database file
    #[arg(long, default_value = "agentdispatch.db")]
    db: PathBuf,

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

    let build_hash = web::build_hash();
    tlog!("Build hash: {}", build_hash);

    // Background task: check building workspaces and finalize them.
    // Sends SSE notification so clients refresh without polling.
    if use_tmux {
        let db_bg = db_arc.clone();
        let tx_bg = tx.clone();
        let hash_bg = build_hash.clone();
        actix_web::rt::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                let changed = {
                    let conn = db_bg.lock().unwrap();
                    projects::check_building_workspaces(&conn)
                };
                if changed {
                    let _ = tx_bg.send(web::UpdateBatch { build_hash: hash_bg.clone() });
                }
            }
        });
    }

    println!("http://localhost:{}", args.port);

    let tx_data = actix_web::web::Data::new(tx);
    let hash_data = actix_web::web::Data::new(build_hash);
    let db_data = actix_web::web::Data::new(db_arc);
    let tmux_data = actix_web::web::Data::new(use_tmux);
    HttpServer::new(move || {
        App::new()
            .app_data(tx_data.clone())
            .app_data(hash_data.clone())
            .app_data(db_data.clone())
            .app_data(tmux_data.clone())
            .service(web::icon)
            .service(web::app_js)
            .service(web::index)
            .service(web::events)
            .service(terminal::ws_terminal)
            .service(projects::list_projects)
            .service(projects::create_project)
            .service(projects::update_project)
            .service(projects::launch_project)
            .service(projects::list_branches)
            .service(projects::list_builds)
            .service(projects::delete_project)
            .service(projects::list_workspaces)
            .service(projects::reorder_workspaces)
            .service(projects::rename_workspace)
            .service(projects::recreate_workspace)
            .service(projects::kill_init_window)
            .service(projects::delete_workspace)
            .service(projects::create_tab)
            .service(projects::update_tab)
            .service(projects::delete_tab)
            .service(projects::list_conda_envs)
            .service(projects::check_git)
    })
    .bind(("127.0.0.1", args.port))?
    .run()
    .await
}
