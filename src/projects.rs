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
    match db::add_project(&conn, &body.name, &root_dir, body.git, agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env) {
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
        body.git, agent, body.claude_internet, body.claude_skip_permissions, &body.conda_env,
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
        db::add_workspace(&conn, &ws_name, &project_name, None, status)
    };

    // Spawn worktree creation in background
    if needs_worktree {
        let root_dir = project.root_dir.clone();
        let agent_str = project.agent.clone();
        let project_clone = project.clone();
        let use_tmux_val = **use_tmux;
        let wt_name = generate_worktree_name();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let base = std::path::PathBuf::from(&home).join("local/worktrees");
        let wt_path = base.join(&wt_name);
        let wt_path_str = wt_path.to_string_lossy().to_string();
        let revision = body.revision.clone().unwrap_or_default();
        let ws_id = ws.id;
        let db = db.clone();

        actix_web::rt::spawn(async move {
            let result = web::block(move || {
                std::fs::create_dir_all(&base)?;
                let mut args = vec![
                    "worktree".to_string(),
                    "add".to_string(),
                    "-b".to_string(),
                    wt_name,
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
                // If any submodule fails (e.g. inaccessible URL), clean up broken
                // .git references so they don't poison the whole worktree.
                if std::path::Path::new(&wt_path_str).join(".gitmodules").exists() {
                    let sub = std::process::Command::new("git")
                        .args(["submodule", "update", "--init", "--recursive"])
                        .current_dir(&wt_path_str)
                        .output();
                    if let Ok(o) = sub {
                        if !o.status.success() {
                            eprintln!("Warning: submodule init failed in {wt_path_str}: {}",
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
                    db::update_workspace_status(&conn, ws_id, "ready", Some(&path));
                    // Create tmux session in the worktree directory
                    if use_tmux_val {
                        let tmux_session = format!("ws-{ws_id}");
                        let agent = normalize_agent(&agent_str).unwrap_or("Claude");
                        let agent_cmd = build_agent_command(agent, &project_clone);
                        if let Err(e) = tmux::new_session(
                            &tmux_session, "agent", &path,
                            if agent != "None" { Some(&agent_cmd) } else { None },
                        ) {
                            eprintln!("Failed to create tmux session for workspace {ws_id}: {e}");
                        }
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("Worktree creation failed for workspace {ws_id}: {e}");
                    db::update_workspace_status(&conn, ws_id, "error", None);
                }
                Err(e) => {
                    eprintln!("Worktree creation failed for workspace {ws_id}: {e}");
                    db::update_workspace_status(&conn, ws_id, "error", None);
                }
            }
        });
    }

    // Create tmux session with agent window (if tmux is enabled and agent is not None)
    if **use_tmux && !needs_worktree {
        let tmux_session = format!("ws-{}", ws.id);
        let cwd = &project.root_dir;
        let agent = normalize_agent(&project.agent).unwrap_or("Claude");
        let agent_cmd = build_agent_command(agent, &project);

        if let Err(e) = tmux::new_session(
            &tmux_session, "agent", cwd,
            if agent != "None" { Some(&agent_cmd) } else { None },
        ) {
            eprintln!("Failed to create tmux session for workspace {}: {e}", ws.id);
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

#[get("/api/workspaces")]
pub async fn list_workspaces(db: Db) -> HttpResponse {
    let conn = db.lock().unwrap();
    HttpResponse::Ok().json(db::list_workspaces(&conn))
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
        let branch_name = std::path::Path::new(&wt_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string());
        let _ = web::block(move || {
            // Try git worktree remove first
            if let Some(ref root) = rd {
                let output = std::process::Command::new("git")
                    .args(["worktree", "remove", "--force", &wt])
                    .current_dir(root)
                    .output();
                if let Ok(o) = output {
                    if o.status.success() {
                        // Delete the branch now that the worktree is gone
                        if let Some(ref branch) = branch_name {
                            let _ = std::process::Command::new("git")
                                .args(["branch", "-D", branch])
                                .current_dir(root)
                                .output();
                        }
                        return;
                    }
                }
            }
            // Fall back to rm -rf
            if let Err(e) = std::fs::remove_dir_all(&wt) {
                eprintln!("Warning: failed to remove worktree dir {wt}: {e}");
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

fn build_agent_command(agent: &str, project: &db::Project) -> String {
    let mut cmd = if agent == "Codex" { "codex".to_string() } else { "claude".to_string() };
    if (agent == "Claude" || agent == "Codex") && project.claude_internet {
        cmd.push_str(" --dangerously-enable-internet-mode");
    }
    if agent == "Claude" && project.claude_skip_permissions {
        cmd.push_str(" --dangerously-skip-permissions");
    }
    if !project.conda_env.is_empty() {
        cmd = format!("conda activate {} && {}", project.conda_env, cmd);
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
    let conn = db.lock().unwrap();
    let tab = db::add_workspace_tab(&conn, ws_id, &body.name, &body.tab_type);

    // Create tmux window for the new tab
    if **use_tmux {
        let tmux_session = format!("ws-{ws_id}");
        let tmux_window = format!("tab-{}", tab.id);
        if tmux::has_session(&tmux_session) {
            // Get the workspace's cwd
            let cwd = db::get_workspace(&conn, ws_id)
                .and_then(|ws| {
                    ws.worktree_dir.or_else(|| {
                        db::list_projects(&conn).into_iter()
                            .find(|p| p.name == ws.project)
                            .map(|p| p.root_dir)
                    })
                })
                .unwrap_or_else(|| "/tmp".to_string());
            if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, &cwd, None) {
                eprintln!("Failed to create tmux window tab-{}: {e}", tab.id);
            }
        }
    }

    HttpResponse::Ok().json(tab)
}

#[derive(Deserialize)]
pub struct RenameWorkspaceRequest {
    name: String,
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
                .service(list_workspaces)
                .service(rename_workspace),
        )
        .await;

        let ws_id = {
            let conn = db.lock().unwrap();
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "")
                .unwrap();
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready").id
        };

        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
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
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
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
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "")
                .unwrap();
            crate::db::add_workspace(&conn, "ws1", "proj", None, "ready").id
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
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
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
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "")
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
        let resp: Vec<serde_json::Value> = actix_web::test::call_and_read_body_json(&app, req).await;
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
            crate::db::add_project(&conn, "proj", "/tmp", false, "Claude", false, false, "")
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
