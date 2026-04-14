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

fn normalize_agent(agent: &str) -> Option<&'static str> {
    match agent {
        "Claude" => Some("Claude"),
        "Codex" => Some("Codex"),
        "None" => Some("None"),
        _ => None,
    }
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
    let agent = match normalize_agent(&body.agent) {
        Some(agent) => agent,
        None => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "agent must be one of: Claude, Codex, None"}));
        }
    };

    let conn = db.lock().unwrap();
    match db::add_project(&conn, &body.name, &root_dir, body.git, agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env, &body.default_branch) {
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
    let agent = match normalize_agent(&body.agent) {
        Some(agent) => agent,
        None => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "agent must be one of: Claude, Codex, None"}));
        }
    };
    let conn = db.lock().unwrap();
    match db::update_project(
        &conn, &old_name, &body.name, &root_dir,
        body.git, agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env, &body.default_branch,
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
    let status = if needs_worktree { "setting_up" } else { "ready" };

    // Insert workspace into DB immediately
    let ws = {
        let conn = db.lock().unwrap();
        let variant = body.build.as_deref().unwrap_or("");
        db::add_workspace(&conn, &ws_name, &project_name, None, status, variant)
    };

    // Spawn worktree creation in background
    if needs_worktree {
        let root_dir = project.root_dir.clone();
        let project_clone = project.clone();
        let use_tmux_val = **use_tmux;
        let wt_name = generate_worktree_name();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let base = std::path::PathBuf::from(&home).join("local/worktrees");
        let wt_path = base.join(&wt_name);
        let wt_path_str = wt_path.to_string_lossy().to_string();
        let revision = body.revision.clone().unwrap_or_default();
        let do_fetch = body.fetch;
        let build_variant = body.build.clone();
        let ws_id = ws.id;
        let db = db.clone();

        actix_web::rt::spawn(async move {
            let db2 = db.clone();
            let root_dir_for_bash = root_dir.clone();
            let variant_for_bash = build_variant.clone();
            let result = web::block(move || {
                let set_phase = |phase: &str| {
                    let conn = db2.lock().unwrap();
                    db::update_workspace_status(&conn, ws_id, phase, None);
                };
                // Fetch latest from remotes if requested (best-effort, 30s timeout)
                if do_fetch {
                    set_phase("fetching");
                    tlog!("Fetching latest for workspace {ws_id}...");
                    let fetch_result = std::process::Command::new("timeout")
                        .args(["30", "git", "fetch", "--all"])
                        .current_dir(&root_dir)
                        .output();
                    match fetch_result {
                        Ok(o) if o.status.success() => {
                            tlog!("Fetch succeeded for workspace {ws_id}");
                        }
                        Ok(o) => {
                            let stderr = String::from_utf8_lossy(&o.stderr);
                            tlog!("Warning: git fetch failed for workspace {ws_id}: {}", stderr.trim());
                        }
                        Err(e) => {
                            tlog!("Warning: git fetch failed for workspace {ws_id}: {e}");
                        }
                    }
                }
                set_phase("creating_worktree");
                std::fs::create_dir_all(&base)?;
                let mut args = vec![
                    "worktree".to_string(),
                    "add".to_string(),
                    "--detach".to_string(),
                    wt_path_str.clone(),
                ];
                if !revision.is_empty() {
                    args.push(revision);
                }
                let output = std::process::Command::new("git")
                    .args(&args)
                    .current_dir(&root_dir)
                    .output()?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(std::io::Error::new(std::io::ErrorKind::Other, stderr.to_string()));
                }
                // Init submodules if the project uses them (best-effort).
                // Skip if there's a build.sh — the build script handles setup.
                // If any submodule fails (e.g. inaccessible URL), clean up broken
                // .git references so they don't poison the whole worktree.
                let has_build_script = find_build_script(&root_dir).is_some();
                if !has_build_script && std::path::Path::new(&wt_path_str).join(".gitmodules").exists() {
                    set_phase("init_submodules");
                    let sub = std::process::Command::new("git")
                        .args(["submodule", "update", "--init", "--recursive"])
                        .current_dir(&wt_path_str)
                        .output();
                    if let Ok(o) = sub {
                        if !o.status.success() {
                            tlog!("Warning: submodule init failed in {wt_path_str}: {}",
                                String::from_utf8_lossy(&o.stderr).trim());
                            // Clean up broken submodule .git files that point to
                            // incomplete gitdirs (missing HEAD, refs, etc.)
                            let _ = std::process::Command::new("bash")
                                .args(["-c", &format!(
                                    "cd '{}' && find . -name .git -type f | while read f; do \
                                        dir=$(cat \"$f\" | sed 's/gitdir: //'); \
                                        if [ ! -f \"$(dirname \"$f\")/$dir/HEAD\" ]; then \
                                            echo \"Removing broken submodule ref: $f\"; \
                                            rm -f \"$f\"; \
                                        fi; \
                                    done", wt_path_str
                                )])
                                .output();
                        }
                    }
                }
                Ok(wt_path_str)
            })
            .await;

            let conn = db.lock().unwrap();
            match result {
                Ok(Ok(path)) => {
                    if !use_tmux_val {
                        db::update_workspace_status(&conn, ws_id, "ready", Some(&path));
                    } else {
                        let tmux_session = format!("ws-{ws_id}");
                        let variant = variant_for_bash.as_deref().unwrap_or("");
                        let agent_cmd = bash_script_cmd("claude", &project_clone, variant, &path);

                        // If there's a build, run it in an init window first
                        let has_build = !variant.is_empty() && find_build_script(&root_dir_for_bash).is_some();
                        if has_build {
                            let build_script = resolve_build_script(&root_dir_for_bash);
                            let bs = shell_escape(&build_script.to_string_lossy());
                            let bv = shell_escape(variant);
                            let bp = shell_escape(&path);
                            let init_cmd = format!("'{bs}' '{bv}' '{bp}'");

                            if let Err(e) = tmux::new_session(
                                &tmux_session, "init", &path, Some(&init_cmd),
                            ) {
                                tlog!("Failed to create tmux session for workspace {ws_id}: {e}");
                                db::update_workspace_status(&conn, ws_id, "error", Some(&path));
                            } else {
                                tmux::set_window_option(&tmux_session, "init", "remain-on-exit", "on");
                                db::update_workspace_status(&conn, ws_id, "building", Some(&path));
                                let db3 = db.clone();
                                let path_clone = path.clone();
                                let tmux_session_clone = tmux_session.clone();
                                actix_web::rt::spawn(async move {
                                    let sess = tmux_session_clone.clone();
                                    // Poll until the init pane's process exits (remain-on-exit keeps it visible)
                                    loop {
                                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                                        if tmux::pane_is_dead(&sess, "init") { break; }
                                    }
                                    let ok = tmux::pane_exit_status(&sess, "init").unwrap_or(-1);

                                    let conn = db3.lock().unwrap();
                                    if ok == 0 {
                                        tlog!("Build succeeded for workspace {ws_id}, creating agent window");
                                        let _ = tmux::new_window(&tmux_session_clone, "agent", &path_clone, Some(&agent_cmd));
                                        db::update_workspace_status(&conn, ws_id, "ready", Some(&path_clone));
                                    } else {
                                        tlog!("Build failed for workspace {ws_id} (exit code {ok})");
                                        db::update_workspace_status(&conn, ws_id, "build_failed", Some(&path_clone));
                                    }
                                });
                            }
                        } else {
                            if let Err(e) = tmux::new_session(
                                &tmux_session, "agent", &path, Some(&agent_cmd),
                            ) {
                                tlog!("Failed to create tmux session for workspace {ws_id}: {e}");
                            }
                            db::update_workspace_status(&conn, ws_id, "ready", Some(&path));
                        }
                    }
                }
                Ok(Err(e)) => {
                    tlog!("Worktree creation failed for workspace {ws_id}: {e}");
                    db::update_workspace_status(&conn, ws_id, "error", None);
                }
                Err(e) => {
                    tlog!("Worktree creation failed for workspace {ws_id}: {e}");
                    db::update_workspace_status(&conn, ws_id, "error", None);
                }
            }
        });
    }

    // Create tmux session with agent window (if tmux is enabled)
    if **use_tmux && !needs_worktree {
        let tmux_session = format!("ws-{}", ws.id);
        let cwd = &project.root_dir;
        let variant = body.build.as_deref().unwrap_or("");
        let agent_cmd = bash_script_cmd("claude", &project, variant, "");
        if let Err(e) = tmux::new_session(
            &tmux_session, "agent", cwd, Some(&agent_cmd),
        ) {
            tlog!("Failed to create tmux session for workspace {}: {e}", ws.id);
        }
    }
    // For git worktree projects, tmux session is created after worktree setup (below)

    HttpResponse::Ok().json(ws)
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
    let workspaces = db::list_workspaces(&conn);
    let divider_pos = db::get_setting(&conn, "ws_divider_pos")
        .and_then(|v| v.parse::<i64>().ok());

    if !**use_tmux {
        let mut resp = serde_json::json!({ "workspaces": workspaces });
        if let Some(dp) = divider_pos { resp["divider_pos"] = serde_json::json!(dp); }
        return HttpResponse::Ok().json(resp);
    }
    // Annotate with agent pane titles
    let titles = tmux::agent_pane_titles();
    let annotated: Vec<serde_json::Value> = workspaces.into_iter().map(|ws| {
        let mut v = serde_json::to_value(&ws).unwrap();
        if let Some(title) = titles.get(&ws.id) {
            v["agent_title"] = serde_json::json!(title);
        }
        v
    }).collect();
    let mut resp = serde_json::json!({ "workspaces": annotated });
    if let Some(dp) = divider_pos { resp["divider_pos"] = serde_json::json!(dp); }
    HttpResponse::Ok().json(resp)
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

    // Delete from DB
    let conn = db.lock().unwrap();
    db::remove_workspace(&conn, id);
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
}

#[derive(Deserialize)]
pub struct CreateTabRequest {
    name: String,
    #[serde(default = "default_shell")]
    tab_type: String,
}

/// Agent command without conda prefix — conda is handled by default bash.sh
/// when bash.sh handles env setup itself.
fn build_bare_agent_command(agent: &str, project: &db::Project) -> String {
    let mut cmd = if agent == "Codex" { "codex".to_string() } else { "claude".to_string() };
    if (agent == "Claude" || agent == "Codex") && project.claude_internet {
        cmd.push_str(" --dangerously-enable-internet-mode");
    }
    if agent == "Claude" && project.claude_skip_permissions {
        cmd.push_str(" --dangerously-skip-permissions");
    }
    cmd
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
    let (tab, cwd, project, variant) = {
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

    let agent_cmd = bash_script_cmd("claude", &project, variant, wt);
    if let Err(e) = tmux::new_session(
        &tmux_session, "agent", cwd, Some(&agent_cmd),
    ) {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": format!("Failed to create tmux session: {e}")}));
    }

    // Recreate tmux windows for existing tabs
    let tabs = {
        let conn = db.lock().unwrap();
        db::list_workspace_tabs(&conn, ws_id)
    };
    let shell_cmd = bash_script_cmd("shell", &project, variant, wt);
    for tab in &tabs {
        let tmux_window = format!("tab-{}", tab.id);
        if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, cwd, Some(&shell_cmd)) {
            tlog!("Failed to recreate tmux window tab-{}: {e}", tab.id);
        }
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
        tmux::kill_window(&format!("ws-{ws_id}"), &format!("tab-{tab_id}"));
    }
    db::remove_workspace_tab(&conn, tab_id);
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
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

    let agent = normalize_agent(&project.agent).unwrap_or("Claude");
    let agent_cmd = if action == "claude" && agent != "None" {
        build_bare_agent_command(agent, project)
    } else {
        String::new()
    };

    let project_bash = find_bash_script(&project.root_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut parts = Vec::new();
    parts.push(format!("AGENTDISPATCH_ACTION={action}"));
    if !agent_cmd.is_empty() {
        parts.push(format!("AGENTDISPATCH_AGENT_CMD='{}'", shell_escape(&agent_cmd)));
    }
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

    #[test]
    fn test_normalize_agent_valid() {
        assert_eq!(normalize_agent("Claude"), Some("Claude"));
        assert_eq!(normalize_agent("Codex"), Some("Codex"));
        assert_eq!(normalize_agent("None"), Some("None"));
    }

    #[test]
    fn test_normalize_agent_invalid() {
        assert_eq!(normalize_agent("invalid"), None);
        assert_eq!(normalize_agent("claude"), None); // case-sensitive
        assert_eq!(normalize_agent(""), None);
        assert_eq!(normalize_agent("GPT"), None);
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
    fn test_bash_script_cmd_claude_basic() {
        let proj = test_project("Claude", false, "");
        let cmd = bash_script_cmd("claude", &proj, "", "");
        assert!(cmd.starts_with("AGENTDISPATCH_ACTION=claude"));
        assert!(cmd.contains("AGENTDISPATCH_AGENT_CMD='claude'"));
        assert!(cmd.contains("AGENTDISPATCH_ROOT_DIR='/tmp/test'"));
        assert!(cmd.contains("exec bash --rcfile"));
    }

    #[test]
    fn test_bash_script_cmd_shell_with_variant() {
        let proj = test_project("Claude", false, "");
        let cmd = bash_script_cmd("shell", &proj, "py310", "");
        assert!(cmd.starts_with("AGENTDISPATCH_ACTION=shell"));
        assert!(cmd.contains("AGENTDISPATCH_VARIANT='py310'"));
        assert!(!cmd.contains("AGENTDISPATCH_AGENT_CMD")); // shell action, no agent cmd
    }

    #[test]
    fn test_bash_script_cmd_with_conda() {
        let proj = test_project("Claude", false, "myenv");
        let cmd = bash_script_cmd("claude", &proj, "", "");
        assert!(cmd.contains("AGENTDISPATCH_CONDA_ENV='myenv'"));
    }

    #[test]
    fn test_bash_script_cmd_with_flags() {
        let proj = test_project("Claude", true, "");
        let cmd = bash_script_cmd("claude", &proj, "", "");
        assert!(cmd.contains("AGENTDISPATCH_AGENT_CMD='claude --dangerously-skip-permissions'"));
    }

    #[test]
    fn test_bash_script_cmd_agent_none() {
        let proj = test_project("None", false, "");
        let cmd = bash_script_cmd("claude", &proj, "", "");
        // Agent=None: no AGENTDISPATCH_AGENT_CMD
        assert!(!cmd.contains("AGENTDISPATCH_AGENT_CMD"));
    }

    #[test]
    fn test_bash_script_cmd_with_worktree() {
        let proj = test_project("Claude", false, "");
        let cmd = bash_script_cmd("claude", &proj, "", "/tmp/wt");
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
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready", "").id
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
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready", "").id
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
