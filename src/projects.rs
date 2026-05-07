use std::sync::{Arc, Mutex};

use actix_web::{HttpResponse, delete, get, post, put, web};
use rand::Rng;
use rusqlite::Connection;
use serde::Deserialize;

use crate::db;
use crate::terminal::UseTmux;
use crate::tmux;

pub type Db = web::Data<Arc<Mutex<Connection>>>;

#[get("/api/projects")]
pub async fn list_projects(db: Db) -> HttpResponse {
    let conn = db.lock().unwrap();
    HttpResponse::Ok().json(db::list_projects(&conn))
}

#[derive(Deserialize)]
pub struct CreateProjectRequest {
    name: String,
    root_dir: String,
    #[serde(default = "default_true")]
    git: bool,
    #[serde(default = "default_agent")]
    agent: String,
    #[serde(default)]
    claude_internet: bool,
    #[serde(default)]
    claude_skip_permissions: bool,
    #[serde(default)]
    conda_env: String,
    #[serde(default)]
    default_branch: String,
    #[serde(default)]
    create_dir: bool,
}

fn default_true() -> bool { true }
fn default_agent() -> String { "Claude".to_string() }

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}


#[post("/api/projects")]
pub async fn create_project(
    db: Db,
    body: web::Json<CreateProjectRequest>,
) -> HttpResponse {
    let root_dir = expand_tilde(&body.root_dir);
    let path = std::path::Path::new(&root_dir);
    if !path.is_dir() {
        if body.create_dir {
            if let Err(e) = std::fs::create_dir_all(&root_dir) {
                return HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": format!("Failed to create directory: {e}")}));
            }
            let output = std::process::Command::new("git")
                .args(["init"])
                .current_dir(&root_dir)
                .output();
            match output {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    return HttpResponse::BadRequest()
                        .json(serde_json::json!({"error": format!("git init failed: {}", stderr.trim())}));
                }
                Err(e) => {
                    return HttpResponse::BadRequest()
                        .json(serde_json::json!({"error": format!("git init failed: {e}")}));
                }
            }
        } else {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": format!("{root_dir} is not a directory"), "dir_not_found": true}));
        }
    }
    let conn = db.lock().unwrap();
    match db::add_project(&conn, &body.name, &root_dir, body.git, &body.agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env, &body.default_branch) {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({"status": "created"})),
        Err(msg) => HttpResponse::BadRequest().json(serde_json::json!({"error": msg})),
    }
}

#[put("/api/projects/{name}")]
pub async fn update_project(
    db: Db,
    path: web::Path<String>,
    body: web::Json<CreateProjectRequest>,
) -> HttpResponse {
    let old_name = path.into_inner();
    let root_dir = expand_tilde(&body.root_dir);
    let path = std::path::Path::new(&root_dir);
    if !path.is_dir() {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({"error": format!("{root_dir} is not a directory")}));
    }
    let conn = db.lock().unwrap();
    match db::update_project(
        &conn, &old_name, &body.name, &root_dir,
        body.git, &body.agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env, &body.default_branch,
    ) {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({"status": "updated"})),
        Err(msg) => HttpResponse::BadRequest().json(serde_json::json!({"error": msg})),
    }
}

#[derive(Deserialize)]
pub struct LaunchRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    revision: Option<String>,
    #[serde(default)]
    fetch: bool,
    #[serde(default)]
    build: Option<String>,
}

#[post("/api/projects/{name}/launch")]
pub async fn launch_project(
    db: Db,
    path: web::Path<String>,
    body: web::Json<LaunchRequest>,
    use_tmux: UseTmux,
) -> HttpResponse {
    let project_name = path.into_inner();

    // Look up project and generate default name (hold lock briefly)
    let (project, default_name) = {
        let conn = db.lock().unwrap();
        let proj = db::list_projects(&conn).into_iter().find(|p| p.name == project_name);
        let name = db::next_workspace_name(&conn, &project_name);
        (proj, name)
    };
    let project = match project {
        Some(p) => p,
        None => return HttpResponse::NotFound().json(serde_json::json!({"error": "project not found"})),
    };

    let ws_name = body.name.as_ref()
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.trim().to_string())
        .unwrap_or(default_name);

    let needs_worktree = project.git;
    let variant = body.build.as_deref().unwrap_or("");

    // For git worktree projects, predict the worktree path so the DB row has
    // it from the start and the init tmux session can be created immediately
    // (running fetch + worktree add + build all in the visible pane).
    let (worktree_dir, init_cwd): (Option<String>, String) = if needs_worktree {
        let wt_name = generate_worktree_name();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let wt_path = std::path::PathBuf::from(&home).join("local/worktrees").join(&wt_name);
        let wt_path_str = wt_path.to_string_lossy().to_string();
        (Some(wt_path_str), project.root_dir.clone())
    } else {
        (None, project.root_dir.clone())
    };

    let status = if **use_tmux { "building" } else { "ready" };

    // Insert workspace into DB with predicted worktree_dir + "building" status
    let ws = {
        let conn = db.lock().unwrap();
        db::add_workspace(&conn, &ws_name, &project_name, worktree_dir.as_deref(), status, variant, "")
    };

    if **use_tmux {
        let tmux_session = format!("ws-{}", ws.id);
        let build_script = resolve_build_script(&project.root_dir);
        let build_path = worktree_dir.as_deref().unwrap_or(&project.root_dir);
        let status_file = format!("/tmp/agentdispatch-init-{}.status", ws.id);
        let init_cmd = build_init_command(
            &status_file,
            needs_worktree,
            body.fetch,
            body.revision.as_deref().unwrap_or(""),
            &build_script.to_string_lossy(),
            variant,
            build_path,
        );

        // Remove stale status file
        let _ = std::fs::remove_file(&status_file);

        if let Err(e) = tmux::new_session_ex(
            &tmux_session, "init", &init_cwd, Some(&init_cmd), false,
        ) {
            tlog!("Failed to create tmux session for workspace {}: {e}", ws.id);
            let conn = db.lock().unwrap();
            db::update_workspace_status(&conn, ws.id, "error", worktree_dir.as_deref());
        } else {
            tlog!("Workspace {} tmux session {tmux_session} created (building)", ws.id);
        }
    }

    HttpResponse::Ok().json(ws)
}

/// Build the init shell command that runs inside the tmux init pane.
///
/// For git-worktree workspaces, does fetch (optional) + `git worktree add` +
/// build script — all in the same pane so the user sees output from t=0. For
/// non-git workspaces, just runs the build script. Either way, an EXIT trap
/// writes the final exit status to `status_file` so `check_building_workspaces`
/// can detect completion even if the pane exits before remain-on-exit is set.
fn build_init_command(
    status_file: &str,
    needs_worktree: bool,
    do_fetch: bool,
    revision: &str,
    build_script: &str,
    variant: &str,
    build_path: &str,
) -> String {
    let sf = shell_escape(status_file);
    let bs = shell_escape(build_script);
    let bv = shell_escape(variant);
    let bp = shell_escape(build_path);

    let mut script = format!(
        "_sf='{sf}'; trap 'echo $? > \"$_sf\"' EXIT HUP\n\
         set -e\n"
    );

    if needs_worktree {
        if do_fetch {
            script.push_str(
                "echo '=== Fetching latest from remote ==='\n\
                 timeout 30 git fetch --all || echo 'Warning: fetch failed'\n",
            );
        }
        let wt_parent = std::path::Path::new(build_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let wtp = shell_escape(&wt_parent);
        let rev_arg = if revision.is_empty() {
            String::new()
        } else {
            format!(" '{}'", shell_escape(revision))
        };
        script.push_str(&format!(
            "mkdir -p '{wtp}'\n\
             echo '=== Creating worktree at {bp} ==='\n\
             git worktree add --detach '{bp}'{rev_arg}\n"
        ));
    }

    script.push_str(&format!("bash '{bs}' '{bv}' '{bp}'\n"));
    script
}

#[delete("/api/projects/{name}")]
pub async fn delete_project(
    db: Db,
    path: web::Path<String>,
) -> HttpResponse {
    let name = path.into_inner();
    let conn = db.lock().unwrap();
    db::remove_project(&conn, &name);
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
}

#[get("/api/projects/{name}/branches")]
pub async fn list_branches(
    db: Db,
    path: web::Path<String>,
) -> HttpResponse {
    let project_name = path.into_inner();
    let root_dir = {
        let conn = db.lock().unwrap();
        db::list_projects(&conn)
            .into_iter()
            .find(|p| p.name == project_name)
            .map(|p| p.root_dir)
    };
    let root_dir = match root_dir {
        Some(d) => d,
        None => return HttpResponse::NotFound().json(serde_json::json!({"error": "project not found"})),
    };

    let result = web::block(move || {
        let output = std::process::Command::new("git")
            .args(["branch", "-a", "--format=%(refname:short)"])
            .current_dir(&root_dir)
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(std::io::Error::new(std::io::ErrorKind::Other, stderr.to_string()));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let branches: Vec<String> = stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with("origin/gh/") && *l != "origin" && !l.starts_with("(HEAD detached"))
            .collect();
        Ok(branches)
    })
    .await;

    match result {
        Ok(Ok(branches)) => HttpResponse::Ok().json(branches),
        Ok(Err(e)) => HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": format!("Failed to list branches: {e}")})),
        Err(e) => HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": format!("Failed to list branches: {e}")})),
    }
}

#[get("/api/projects/{name}/builds")]
pub async fn list_builds(
    db: Db,
    path: web::Path<String>,
) -> HttpResponse {
    let project_name = path.into_inner();
    let root_dir = {
        let conn = db.lock().unwrap();
        db::list_projects(&conn)
            .into_iter()
            .find(|p| p.name == project_name)
            .map(|p| p.root_dir)
    };
    let root_dir = match root_dir {
        Some(d) => d,
        None => return HttpResponse::NotFound().json(serde_json::json!({"error": "project not found"})),
    };

    let script = resolve_build_script(&root_dir);

    let result = web::block(move || -> Result<Vec<String>, std::io::Error> {
        let script_str = script.to_string_lossy().to_string();
        let output = std::process::Command::new("timeout")
            .args(["5", &script_str, "--list"])
            .current_dir(&root_dir)
            .output()?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let builds: Vec<String> = stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(builds)
    })
    .await;

    match result {
        Ok(Ok(builds)) => HttpResponse::Ok().json(builds),
        _ => HttpResponse::Ok().json(Vec::<String>::new()),
    }
}

#[get("/api/workspaces")]
pub async fn list_workspaces(db: Db, use_tmux: UseTmux) -> HttpResponse {
    let conn = db.lock().unwrap();
    let divider_pos = db::get_setting(&conn, "ws_divider_pos")
        .and_then(|v| v.parse::<i64>().ok());

    if !**use_tmux {
        let workspaces = db::list_workspaces(&conn);
        let mut resp = serde_json::json!({ "workspaces": workspaces });
        if let Some(dp) = divider_pos { resp["divider_pos"] = serde_json::json!(dp); }
        return HttpResponse::Ok().json(resp);
    }

    check_building_workspaces(&conn);
    adopt_orphan_windows(&conn);
    let workspaces = db::list_workspaces(&conn);

    let annotated: Vec<serde_json::Value> = workspaces.into_iter().map(|ws| {
        let mut v = serde_json::to_value(&ws).unwrap();
        let session = format!("ws-{}", ws.id);
        if let Some((true, _)) = tmux::init_pane_status(&session) {
            v["has_init"] = serde_json::json!(true);
        }
        v
    }).collect();
    let mut resp = serde_json::json!({ "workspaces": annotated });
    if let Some(dp) = divider_pos { resp["divider_pos"] = serde_json::json!(dp); }
    HttpResponse::Ok().json(resp)
}

/// Scan ready workspaces for tmux windows not tracked as tabs and adopt them.
fn adopt_orphan_windows(conn: &rusqlite::Connection) {
    let workspaces = db::list_workspaces(conn);
    for ws in &workspaces {
        if ws.status != "ready" { continue; }
        let session = format!("ws-{}", ws.id);
        if !tmux::has_session(&session) { continue; }
        let windows = tmux::list_windows(&session);
        let tracked: std::collections::HashSet<String> = ws.tabs.iter()
            .map(|t| format!("tab-{}", t.id))
            .collect();
        for win_name in &windows {
            if win_name == "init" || tracked.contains(win_name) { continue; }
            let tab = db::add_workspace_tab(conn, ws.id, win_name, "shell");
            let new_name = format!("tab-{}", tab.id);
            tmux::rename_window(&session, win_name, &new_name);
            tlog!("Adopted orphan window {win_name} in ws-{} as tab-{}", ws.id, tab.id);
        }
    }
}

/// Check all "building" workspaces and finalize any whose init pane has exited.
/// Returns true if any workspace status changed (caller should notify clients).
pub fn check_building_workspaces(conn: &rusqlite::Connection) -> bool {
    let workspaces = db::list_workspaces(conn);
    let projects = db::list_projects(conn);
    let mut changed = false;
    for ws in &workspaces {
        if ws.status != "building" { continue; }
        let session = format!("ws-{}", ws.id);
        let status_file = format!("/tmp/agentdispatch-init-{}.status", ws.id);
        let ok: i32;
        if let Some((true, exit_status)) = tmux::init_pane_status(&session) {
            ok = exit_status.unwrap_or(0);
        } else if let Ok(content) = std::fs::read_to_string(&status_file) {
            ok = content.trim().parse().unwrap_or(-1);
        } else {
            continue;
        }
        let _ = std::fs::remove_file(&status_file);
        if ok == 0 {
            if let Some(proj) = projects.iter().find(|p| p.name == ws.project) {
                let wt = ws.worktree_dir.as_deref().unwrap_or(&proj.root_dir);
                let shell_cmd = bash_script_cmd("shell", proj, &ws.build_variant, wt);
                let tab = db::add_workspace_tab(conn, ws.id, "shell", "shell");
                let tmux_window = format!("tab-{}", tab.id);
                tlog!("Build succeeded for workspace {}, creating shell tab {}", ws.id, tab.id);
                if tmux::has_session(&session) {
                    let _ = tmux::new_window(&session, &tmux_window, wt, Some(&shell_cmd));
                } else {
                    let _ = tmux::new_session(&session, &tmux_window, wt, Some(&shell_cmd));
                }
            }
            db::update_workspace_status(conn, ws.id, "ready", ws.worktree_dir.as_deref());
        } else {
            tlog!("Build failed for workspace {} (exit code {ok})", ws.id);
            db::update_workspace_status(conn, ws.id, "build_failed", ws.worktree_dir.as_deref());
        }
        changed = true;
    }
    changed
}

#[post("/api/workspaces/{id}/kill-init")]
pub async fn kill_init_window(path: web::Path<i64>) -> HttpResponse {
    let ws_id = path.into_inner();
    let session = format!("ws-{ws_id}");
    tmux::kill_window(&session, "init");
    HttpResponse::Ok().json(serde_json::json!({"status": "ok"}))
}

#[delete("/api/workspaces/{id}")]
pub async fn delete_workspace(
    db: Db,
    path: web::Path<i64>,
) -> HttpResponse {
    let id = path.into_inner();

    // Read workspace and project info before deleting
    let (worktree_dir, root_dir) = {
        let conn = db.lock().unwrap();
        let ws = db::get_workspace(&conn, id);
        let wt = ws.as_ref().and_then(|w| w.worktree_dir.clone());
        let rd = ws.as_ref().and_then(|w| {
            db::list_projects(&conn).into_iter().find(|p| p.name == w.project).map(|p| p.root_dir)
        });
        (wt, rd)
    };

    // Clean up worktree on disk and its branch
    if let Some(wt_path) = worktree_dir {
        let rd = root_dir.clone();
        let wt = wt_path.clone();
        let _ = web::block(move || {
            // Try git worktree remove first
            if let Some(ref root) = rd {
                let output = std::process::Command::new("git")
                    .args(["worktree", "remove", "--force", &wt])
                    .current_dir(root)
                    .output();
                if let Ok(o) = output {
                    if o.status.success() {
                        return;
                    }
                }
            }
            // Fall back to rm -rf
            if let Err(e) = std::fs::remove_dir_all(&wt) {
                tlog!("Warning: failed to remove worktree dir {wt}: {e}");
            }
        })
        .await;
    }

    // Kill tmux session
    tmux::kill_session(&format!("ws-{id}"));

    // Delete from DB, adjusting divider if workspace was above it
    let conn = db.lock().unwrap();
    let workspaces = db::list_workspaces(&conn);
    let removed_idx = workspaces.iter().position(|w| w.id == id);
    db::remove_workspace(&conn, id);
    if let Some(idx) = removed_idx {
        let divider_pos = db::get_setting(&conn, "ws_divider_pos")
            .and_then(|v| v.parse::<usize>().ok());
        if let Some(dp) = divider_pos {
            if idx < dp {
                db::set_setting(&conn, "ws_divider_pos", &(dp - 1).to_string());
            }
        }
    }
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
}

#[derive(Deserialize)]
pub struct CreateTabRequest {
    name: String,
    #[serde(default = "default_shell")]
    tab_type: String,
}

fn default_shell() -> String { "shell".to_string() }

#[post("/api/workspaces/{id}/tabs")]
pub async fn create_tab(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<CreateTabRequest>,
    use_tmux: UseTmux,
) -> HttpResponse {
    let ws_id = path.into_inner();
    let (tab, mut cwd, project, variant) = {
        let conn = db.lock().unwrap();
        let tab = db::add_workspace_tab(&conn, ws_id, &body.name, &body.tab_type);
        let ws = db::get_workspace(&conn, ws_id);
        let variant = ws.as_ref().map(|w| w.build_variant.clone()).unwrap_or_default();
        let wt = ws.as_ref().and_then(|w| w.worktree_dir.clone());
        let project = ws.as_ref().and_then(|w| {
            db::list_projects(&conn).into_iter().find(|p| p.name == w.project)
        });
        let cwd = wt.or_else(|| project.as_ref().map(|p| p.root_dir.clone()))
            .unwrap_or_else(|| "/tmp".to_string());
        (tab, cwd, project, variant)
    };

    // Create tmux window for the new tab (outside DB lock)
    if **use_tmux {
        let tmux_session = format!("ws-{ws_id}");
        let tmux_window = format!("tab-{}", tab.id);
        if tmux::has_session(&tmux_session) {
            if let Some(pane_cwd) = tmux::first_pane_cwd(&tmux_session) {
                cwd = pane_cwd;
            }
            let shell_cmd = if let Some(ref proj) = project {
                let wt = if cwd != proj.root_dir { &cwd } else { "" };
                Some(bash_script_cmd("shell", proj, &variant, wt))
            } else { None };
            if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, &cwd, shell_cmd.as_deref()) {
                tlog!("Failed to create tmux window tab-{}: {e}", tab.id);
            }
        }
    }

    HttpResponse::Ok().json(tab)
}

#[derive(Deserialize)]
pub struct RenameWorkspaceRequest {
    name: String,
}

#[post("/api/workspaces/{id}/recreate")]
pub async fn recreate_workspace(
    db: Db,
    path: web::Path<i64>,
    use_tmux: UseTmux,
) -> HttpResponse {
    let ws_id = path.into_inner();
    let (ws, project) = {
        let conn = db.lock().unwrap();
        let ws = db::get_workspace(&conn, ws_id);
        let proj = ws.as_ref().and_then(|w| {
            db::list_projects(&conn).into_iter().find(|p| p.name == w.project)
        });
        (ws, proj)
    };
    let ws = match ws {
        Some(w) => w,
        None => return HttpResponse::NotFound().json(serde_json::json!({"error": "workspace not found"})),
    };
    let project = match project {
        Some(p) => p,
        None => return HttpResponse::NotFound().json(serde_json::json!({"error": "project not found"})),
    };

    if !**use_tmux {
        return HttpResponse::Ok().json(serde_json::json!({"status": "ok"}));
    }

    let tmux_session = format!("ws-{ws_id}");
    // Kill existing session if any
    tmux::kill_session(&tmux_session);

    let cwd = ws.worktree_dir.as_deref().unwrap_or(&project.root_dir);
    let wt = ws.worktree_dir.as_deref().unwrap_or("");
    let variant = &ws.build_variant;

    let shell_cmd = bash_script_cmd("shell", &project, variant, wt);

    // Recreate tmux windows for existing tabs
    let tabs = {
        let conn = db.lock().unwrap();
        db::list_workspace_tabs(&conn, ws_id)
    };
    for tab in &tabs {
        let tmux_window = format!("tab-{}", tab.id);
        if tmux::has_session(&tmux_session) {
            if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, cwd, Some(&shell_cmd)) {
                tlog!("Failed to recreate tmux window tab-{}: {e}", tab.id);
            }
        } else if let Err(e) = tmux::new_session(&tmux_session, &tmux_window, cwd, Some(&shell_cmd)) {
            tlog!("Failed to create tmux session for tab-{}: {e}", tab.id);
        }
    }
    if !tmux::has_session(&tmux_session) {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": "Failed to create tmux session — no tabs to recreate"}));
    }

    HttpResponse::Ok().json(serde_json::json!({"status": "recreated"}))
}

#[derive(Deserialize)]
pub struct ReorderRequest {
    ids: Vec<i64>,
    #[serde(default)]
    divider_pos: Option<i64>,
}

#[post("/api/workspaces/reorder")]
pub async fn reorder_workspaces(
    db: Db,
    body: web::Json<ReorderRequest>,
) -> HttpResponse {
    let conn = db.lock().unwrap();
    db::reorder_workspaces(&conn, &body.ids);
    if let Some(pos) = body.divider_pos {
        db::set_setting(&conn, "ws_divider_pos", &pos.to_string());
    }
    HttpResponse::Ok().json(serde_json::json!({"status": "reordered"}))
}

#[put("/api/workspaces/{id}")]
pub async fn rename_workspace(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<RenameWorkspaceRequest>,
) -> HttpResponse {
    let id = path.into_inner();
    let conn = db.lock().unwrap();
    db::rename_workspace(&conn, id, &body.name);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

#[derive(Deserialize)]
pub struct RenameTabRequest {
    name: String,
}

#[put("/api/tabs/{id}")]
pub async fn update_tab(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<RenameTabRequest>,
) -> HttpResponse {
    let tab_id = path.into_inner();
    let conn = db.lock().unwrap();
    db::update_workspace_tab(&conn, tab_id, &body.name);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

#[delete("/api/tabs/{id}")]
pub async fn delete_tab(
    db: Db,
    path: web::Path<i64>,
) -> HttpResponse {
    let tab_id = path.into_inner();
    let conn = db.lock().unwrap();
    // Kill tmux window before removing from DB
    if let Some(ws_id) = db::get_workspace_id_for_tab(&conn, tab_id) {
        tlog!("[api] DELETE /api/tabs/{tab_id} (ws-{ws_id}): killing tmux window and removing from DB");
        tmux::kill_window(&format!("ws-{ws_id}"), &format!("tab-{tab_id}"));
    } else {
        tlog!("[api] DELETE /api/tabs/{tab_id}: no workspace found for tab, removing from DB only");
    }
    db::remove_workspace_tab(&conn, tab_id);
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
}

#[derive(Deserialize)]
pub struct ClientLogEntry {
    level: String,
    msg: String,
}

#[derive(Deserialize)]
pub struct ClientLogBody {
    entries: Vec<ClientLogEntry>,
}

#[post("/api/client-log")]
pub async fn client_log(body: web::Json<ClientLogBody>) -> HttpResponse {
    for entry in &body.entries {
        tlog!("[client {}] {}", entry.level, entry.msg);
    }
    HttpResponse::Ok().finish()
}

#[derive(Deserialize)]
pub struct CheckGitQuery {
    path: String,
}

#[get("/api/check-git")]
pub async fn check_git(query: web::Query<CheckGitQuery>) -> HttpResponse {
    let path = expand_tilde(&query.path);
    let is_git = std::process::Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(&path)
        .output()
        .is_ok_and(|o| o.status.success());
    HttpResponse::Ok().json(serde_json::json!({"git": is_git}))
}

#[get("/api/conda-envs")]
pub async fn list_conda_envs() -> HttpResponse {
    let envs = get_conda_envs();
    HttpResponse::Ok().json(envs)
}

const ADJECTIVES: &[&str] = &[
    "bright", "calm", "cool", "crisp", "dark", "deft", "fair", "fast",
    "fine", "firm", "free", "glad", "gold", "good", "keen", "kind",
    "lean", "lush", "mild", "neat", "pale", "pure", "rare", "rich",
    "safe", "slim", "soft", "sure", "tall", "warm",
];

const NOUNS: &[&str] = &[
    "arch", "bark", "bell", "bird", "bolt", "cape", "claw", "cove",
    "dawn", "dune", "edge", "elk", "fern", "flint", "frost", "gate",
    "glen", "hawk", "helm", "hill", "jade", "lake", "lark", "leaf",
    "lynx", "mesa", "mist", "moth", "oak", "owl", "peak", "pine",
    "rain", "reef", "sage", "vale", "vine", "wave", "wren", "wolf",
];

fn generate_worktree_name() -> String {
    let mut rng = rand::rng();
    let adj = ADJECTIVES[rng.random_range(0..ADJECTIVES.len())];
    let noun = NOUNS[rng.random_range(0..NOUNS.len())];
    format!("{adj}-{noun}")
}

/// Find the build script for a project. Checks two locations:
/// 1. {root_dir}/.agentdispatch/build.sh
/// 2. {root_dir}/../.agentdispatch/{basename(root_dir)}/build.sh
/// Find a file in the .agentdispatch directory. Checks two locations:
/// 1. {root_dir}/.agentdispatch/{filename}
/// 2. {root_dir}/../.agentdispatch/{basename(root_dir)}/{filename}
fn find_agentdispatch_file(root_dir: &str, filename: &str) -> Option<std::path::PathBuf> {
    let root = std::path::Path::new(root_dir);
    // Location 1: in-tree
    let in_tree = root.join(".agentdispatch").join(filename);
    if in_tree.is_file() {
        return std::fs::canonicalize(&in_tree).ok();
    }
    // Location 2: sibling directory
    let basename = root.file_name()?;
    let sibling = root.parent()?.join(".agentdispatch").join(basename).join(filename);
    if sibling.is_file() {
        return std::fs::canonicalize(&sibling).ok();
    }
    None
}

fn find_build_script(root_dir: &str) -> Option<std::path::PathBuf> {
    find_agentdispatch_file(root_dir, "build.sh")
}

fn find_bash_script(root_dir: &str) -> Option<std::path::PathBuf> {
    find_agentdispatch_file(root_dir, "bash.sh")
}

/// Config directory for agentdispatch defaults (~/.config/agentdispatch).
fn config_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(home).join(".config/agentdispatch")
}

const DEFAULT_BASH_SH: &str = include_str!("../static/default-bash.sh");
const DEFAULT_BUILD_SH: &str = include_str!("../static/default-build.sh");

/// Ensure a default config file exists, writing it from embedded content if missing.
fn ensure_config_file(name: &str, content: &str) -> std::path::PathBuf {
    let path = config_dir().join(name);
    if !path.is_file() {
        std::fs::create_dir_all(config_dir()).ok();
        std::fs::write(&path, content).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).ok();
        }
    }
    path
}

fn default_bash_sh_path() -> std::path::PathBuf {
    ensure_config_file("default-bash.sh", DEFAULT_BASH_SH)
}

/// Path to the build script for a project. Checks project-specific locations first,
/// then falls back to the default in ~/.config/agentdispatch.
fn resolve_build_script(root_dir: &str) -> std::path::PathBuf {
    if let Some(p) = find_build_script(root_dir) {
        return p;
    }
    ensure_config_file("default-build.sh", DEFAULT_BUILD_SH)
}

fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Build the tmux command string for a pane. Always uses the default bash.sh,
/// passing all config as env vars.
fn bash_script_cmd(action: &str, project: &db::Project, variant: &str, worktree: &str) -> String {
    let default_script = default_bash_sh_path();
    let s = shell_escape(&default_script.to_string_lossy());

    let project_bash = find_bash_script(&project.root_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut parts = Vec::new();
    parts.push(format!("AGENTDISPATCH_ACTION={action}"));
    if !variant.is_empty() {
        parts.push(format!("AGENTDISPATCH_VARIANT='{}'", shell_escape(variant)));
    }
    if !project.conda_env.is_empty() {
        parts.push(format!("AGENTDISPATCH_CONDA_ENV='{}'", shell_escape(&project.conda_env)));
    }
    if !project_bash.is_empty() {
        parts.push(format!("AGENTDISPATCH_PROJECT_BASH='{}'", shell_escape(&project_bash)));
    }
    parts.push(format!("AGENTDISPATCH_ROOT_DIR='{}'", shell_escape(&project.root_dir)));
    if !worktree.is_empty() {
        parts.push(format!("AGENTDISPATCH_WORKTREE='{}'", shell_escape(worktree)));
    }
    parts.push(format!("exec bash --rcfile '{s}'"));
    parts.join(" ")
}

fn get_conda_envs() -> Vec<String> {
    let output = std::process::Command::new("conda")
        .args(["env", "list", "--json"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(envs) = parsed["envs"].as_array() {
                    let mut names: Vec<String> = envs
                        .iter()
                        .filter_map(|e| {
                            e.as_str().and_then(|p| {
                                std::path::Path::new(p)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                            })
                        })
                        .collect();
                    names.sort();
                    names.dedup();
                    return names;
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Pure function tests --

    #[test]
    fn test_expand_tilde_with_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(expand_tilde("~/foo/bar"), format!("{home}/foo/bar"));
    }

    #[test]
    fn test_expand_tilde_absolute() {
        assert_eq!(expand_tilde("/absolute/path"), "/absolute/path");
    }

    #[test]
    fn test_expand_tilde_relative() {
        assert_eq!(expand_tilde("relative/path"), "relative/path");
    }

    #[test]
    fn test_expand_tilde_bare() {
        // "~nope" without slash should NOT expand
        assert_eq!(expand_tilde("~nope"), "~nope");
    }

    fn make_temp_dir() -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("agentdispatch-test-{}", std::process::id()));
        path.push(format!("{}", rand::random::<u32>()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_find_build_script_in_tree() {
        let root = make_temp_dir();
        let script = root.join(".agentdispatch/build.sh");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "#!/bin/bash\n").unwrap();
        let result = find_build_script(root.to_str().unwrap());
        assert!(result.is_some());
        assert!(result.unwrap().to_str().unwrap().ends_with("build.sh"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_find_build_script_sibling() {
        let base = make_temp_dir();
        let root = base.join("myproject");
        std::fs::create_dir_all(&root).unwrap();
        let script = base.join(".agentdispatch/myproject/build.sh");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "#!/bin/bash\n").unwrap();
        let result = find_build_script(root.to_str().unwrap());
        assert!(result.is_some());
        assert!(result.unwrap().to_str().unwrap().ends_with("build.sh"));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_find_build_script_in_tree_takes_priority() {
        let base = make_temp_dir();
        let root = base.join("myproject");
        std::fs::create_dir_all(&root).unwrap();
        let in_tree = root.join(".agentdispatch/build.sh");
        std::fs::create_dir_all(in_tree.parent().unwrap()).unwrap();
        std::fs::write(&in_tree, "#!/bin/bash\necho intree\n").unwrap();
        let sibling = base.join(".agentdispatch/myproject/build.sh");
        std::fs::create_dir_all(sibling.parent().unwrap()).unwrap();
        std::fs::write(&sibling, "#!/bin/bash\necho sibling\n").unwrap();
        let result = find_build_script(root.to_str().unwrap());
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.starts_with(std::fs::canonicalize(&root).unwrap()));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_find_build_script_none() {
        let dir = make_temp_dir();
        let result = find_build_script(dir.to_str().unwrap());
        assert!(result.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_find_bash_script_in_tree() {
        let root = make_temp_dir();
        let script = root.join(".agentdispatch/bash.sh");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "#!/bin/bash\n").unwrap();
        let result = find_bash_script(root.to_str().unwrap());
        assert!(result.is_some());
        assert!(result.unwrap().to_str().unwrap().ends_with("bash.sh"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_find_bash_script_sibling() {
        let base = make_temp_dir();
        let root = base.join("myproject");
        std::fs::create_dir_all(&root).unwrap();
        let script = base.join(".agentdispatch/myproject/bash.sh");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "#!/bin/bash\n").unwrap();
        let result = find_bash_script(root.to_str().unwrap());
        assert!(result.is_some());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_find_bash_script_none() {
        let dir = make_temp_dir();
        assert!(find_bash_script(dir.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn test_project(agent: &str, skip_perms: bool, conda: &str) -> db::Project {
        db::Project {
            name: "test".to_string(),
            root_dir: "/tmp/test".to_string(),
            git: false,
            agent: agent.to_string(),
            claude_internet: false,
            claude_skip_permissions: skip_perms,
            conda_env: conda.to_string(),
            default_branch: String::new(),
        }
    }

    #[test]
    fn test_bash_script_cmd_basic() {
        let proj = test_project("", false, "");
        let cmd = bash_script_cmd("shell", &proj, "", "");
        assert!(cmd.starts_with("AGENTDISPATCH_ACTION=shell"));
        assert!(cmd.contains("AGENTDISPATCH_ROOT_DIR='/tmp/test'"));
        assert!(cmd.contains("exec bash --rcfile"));
        assert!(!cmd.contains("AGENTDISPATCH_AGENT_CMD"));
    }

    #[test]
    fn test_bash_script_cmd_with_variant() {
        let proj = test_project("", false, "");
        let cmd = bash_script_cmd("shell", &proj, "py310", "");
        assert!(cmd.contains("AGENTDISPATCH_VARIANT='py310'"));
    }

    #[test]
    fn test_bash_script_cmd_with_conda() {
        let proj = test_project("", false, "myenv");
        let cmd = bash_script_cmd("shell", &proj, "", "");
        assert!(cmd.contains("AGENTDISPATCH_CONDA_ENV='myenv'"));
    }

    #[test]
    fn test_bash_script_cmd_with_worktree() {
        let proj = test_project("", false, "");
        let cmd = bash_script_cmd("shell", &proj, "", "/tmp/wt");
        assert!(cmd.contains("AGENTDISPATCH_WORKTREE='/tmp/wt'"));
    }

    // -- API integration tests --

    use actix_web::App;
    use std::sync::{Arc, Mutex};

    fn test_app_data() -> actix_web::web::Data<Arc<Mutex<rusqlite::Connection>>> {
        let conn = crate::db::init_db(std::path::Path::new(":memory:"));
        actix_web::web::Data::new(Arc::new(Mutex::new(conn)))
    }

    fn test_tmux_data() -> actix_web::web::Data<bool> {
        actix_web::web::Data::new(false) // tmux disabled in tests
    }

    /// Extract workspace array from the /api/workspaces response (which wraps in {workspaces:[...]})
    fn extract_workspaces(body: serde_json::Value) -> Vec<serde_json::Value> {
        body["workspaces"].as_array().cloned().unwrap_or_default()
    }

    #[actix_web::test]
    async fn test_list_projects_empty() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).service(list_projects),
        )
        .await;
        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert!(resp.is_empty());
    }

    #[actix_web::test]
    async fn test_create_project_success() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db)
                .service(create_project)
                .service(list_projects),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({"name": "test", "root_dir": "/tmp"}))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp.len(), 1);
        assert_eq!(resp[0]["name"], "test");
    }

    #[actix_web::test]
    async fn test_create_project_defaults() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db)
                .service(create_project)
                .service(list_projects),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({"name": "test", "root_dir": "/tmp"}))
            .to_request();
        actix_web::test::call_service(&app, req).await;

        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp[0]["git"], true);
        assert_eq!(resp[0]["agent"], "Claude");
        assert_eq!(resp[0]["claude_internet"], false);
        assert_eq!(resp[0]["claude_skip_permissions"], false);
        assert_eq!(resp[0]["conda_env"], "");
    }

    #[actix_web::test]
    async fn test_create_project_bad_dir() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).service(create_project),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({
                "name": "test",
                "root_dir": "/nonexistent/path/xyz"
            }))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status().as_u16(), 400);
    }

    #[actix_web::test]
    async fn test_create_project_bad_dir_returns_dir_not_found() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).service(create_project),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({
                "name": "test",
                "root_dir": "/nonexistent/path/xyz"
            }))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["dir_not_found"], true);
    }

    #[actix_web::test]
    async fn test_create_project_creates_dir() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db)
                .service(create_project)
                .service(list_projects),
        )
        .await;

        let dir = format!("/tmp/agentdispatch-test-create-dir-{}", std::process::id());
        // Ensure clean state
        let _ = std::fs::remove_dir_all(&dir);

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({
                "name": "test-create",
                "root_dir": &dir,
                "create_dir": true
            }))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success(), "create with create_dir should succeed");

        // Directory should exist with .git
        assert!(std::path::Path::new(&dir).is_dir(), "directory should be created");
        assert!(std::path::Path::new(&dir).join(".git").exists(), "git init should have run");

        // Project should be in the list
        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp.len(), 1);
        assert_eq!(resp[0]["name"], "test-create");

        // Clean up
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[actix_web::test]
    async fn test_create_project_bad_agent() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).service(create_project),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({
                "name": "test",
                "root_dir": "/tmp",
                "agent": "InvalidAgent"
            }))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status().as_u16(), 400);
    }

    #[actix_web::test]
    async fn test_create_project_duplicate() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).service(create_project),
        )
        .await;

        let body = serde_json::json!({"name": "test", "root_dir": "/tmp"});
        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(&body)
            .to_request();
        actix_web::test::call_service(&app, req).await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(&body)
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status().as_u16(), 400);
    }

    #[actix_web::test]
    async fn test_update_project_endpoint() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db)
                .service(create_project)
                .service(update_project)
                .service(list_projects),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({"name": "old", "root_dir": "/tmp"}))
            .to_request();
        actix_web::test::call_service(&app, req).await;

        let req = actix_web::test::TestRequest::put()
            .uri("/api/projects/old")
            .set_json(serde_json::json!({"name": "new", "root_dir": "/tmp", "agent": "Codex"}))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp.len(), 1);
        assert_eq!(resp[0]["name"], "new");
        assert_eq!(resp[0]["agent"], "Codex");
    }

    #[actix_web::test]
    async fn test_delete_project_endpoint() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db)
                .service(create_project)
                .service(delete_project)
                .service(list_projects),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects")
            .set_json(serde_json::json!({"name": "test", "root_dir": "/tmp"}))
            .to_request();
        actix_web::test::call_service(&app, req).await;

        let req = actix_web::test::TestRequest::delete()
            .uri("/api/projects/test")
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let req = actix_web::test::TestRequest::get().uri("/api/projects").to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
        assert!(resp.is_empty());
    }

    #[actix_web::test]
    async fn test_workspace_list_and_rename() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(list_workspaces)
                .service(rename_workspace),
        )
        .await;

        let ws_id = {
            let conn = db.lock().unwrap();
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "", "")
                .unwrap();
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready", "", "").id
        };

        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert_eq!(resp.len(), 1);
        assert_eq!(resp[0]["name"], "ws1");

        let req = actix_web::test::TestRequest::put()
            .uri(&format!("/api/workspaces/{ws_id}"))
            .set_json(serde_json::json!({"name": "renamed"}))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert_eq!(resp[0]["name"], "renamed");
    }

    #[actix_web::test]
    async fn test_tab_crud() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(create_tab)
                .service(update_tab)
                .service(delete_tab)
                .service(list_workspaces),
        )
        .await;

        let ws_id = {
            let conn = db.lock().unwrap();
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "", "")
                .unwrap();
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready", "", "").id
        };

        // Create tab
        let req = actix_web::test::TestRequest::post()
            .uri(&format!("/api/workspaces/{ws_id}/tabs"))
            .set_json(serde_json::json!({"name": "shell", "tab_type": "shell"}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        let tab_id = resp["id"].as_i64().unwrap();
        assert_eq!(resp["name"], "shell");

        // Update tab
        let req = actix_web::test::TestRequest::put()
            .uri(&format!("/api/tabs/{tab_id}"))
            .set_json(serde_json::json!({"name": "renamed"}))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        // Delete tab
        let req = actix_web::test::TestRequest::delete()
            .uri(&format!("/api/tabs/{tab_id}"))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        // Verify gone
        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert!(resp[0]["tabs"].as_array().unwrap().is_empty());
    }

    #[actix_web::test]
    async fn test_launch_project_not_found() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db).app_data(test_tmux_data()).service(launch_project),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects/nonexistent/launch")
            .set_json(serde_json::json!({}))
            .to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert_eq!(resp.status().as_u16(), 404);
    }

    #[actix_web::test]
    async fn test_launch_project_no_git() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(launch_project)
                .service(list_workspaces),
        )
        .await;

        {
            let conn = db.lock().unwrap();
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "", "")
                .unwrap();
        }

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects/proj/launch")
            .set_json(serde_json::json!({}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["project"], "proj");
        assert_eq!(resp["status"], "ready");

        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert_eq!(resp.len(), 1);
    }

    #[actix_web::test]
    async fn test_launch_project_custom_name() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new().app_data(db.clone()).app_data(test_tmux_data()).service(launch_project),
        )
        .await;

        {
            let conn = db.lock().unwrap();
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "", "")
                .unwrap();
        }

        let req = actix_web::test::TestRequest::post()
            .uri("/api/projects/proj/launch")
            .set_json(serde_json::json!({"name": "my-workspace"}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["name"], "my-workspace");
    }
}
