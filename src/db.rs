use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

pub fn init_db(path: &Path) -> Connection {
    let conn = Connection::open(path)
        .unwrap_or_else(|e| panic!("Failed to open database {:?}: {}", path, e));
    conn.execute_batch("PRAGMA journal_mode=WAL")
        .expect("Failed to set WAL mode");
    run_migrations(&conn);
    conn
}

const CURRENT_VERSION: i64 = 8;

const MIGRATIONS: &[&str] = &[
    // 0 -> 1: projects table
    "CREATE TABLE IF NOT EXISTS projects (
        name TEXT NOT NULL PRIMARY KEY,
        root_dir TEXT NOT NULL
    )",
    // 1 -> 2: add git, claude_internet, claude_skip_permissions columns
    "ALTER TABLE projects ADD COLUMN git INTEGER NOT NULL DEFAULT 1;
     ALTER TABLE projects ADD COLUMN claude_internet INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE projects ADD COLUMN claude_skip_permissions INTEGER NOT NULL DEFAULT 0",
    // 2 -> 3: workspaces table
    "CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )",
    // 3 -> 4: add conda_env to projects
    "ALTER TABLE projects ADD COLUMN conda_env TEXT NOT NULL DEFAULT ''",
    // 4 -> 5: workspace_tabs table
    "CREATE TABLE workspace_tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        tab_type TEXT NOT NULL DEFAULT 'shell'
    )",
    // 5 -> 6: add worktree_dir to workspaces
    "ALTER TABLE workspaces ADD COLUMN worktree_dir TEXT",
    // 6 -> 7: add status to workspaces
    "ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'",
    // 7 -> 8: add agent to projects
    "ALTER TABLE projects ADD COLUMN agent TEXT NOT NULL DEFAULT 'Claude'",
];

fn run_migrations(conn: &Connection) {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);

    for v in version..CURRENT_VERSION {
        let idx = v as usize;
        tlog!("Running migration {} -> {}", v, v + 1);
        conn.execute_batch(MIGRATIONS[idx])
            .unwrap_or_else(|e| panic!("Migration {} -> {} failed: {}", v, v + 1, e));
        conn.execute_batch(&format!("PRAGMA user_version = {}", v + 1))
            .expect("Failed to set user_version");
    }
}

#[derive(Serialize, Clone)]
pub struct Project {
    pub name: String,
    pub root_dir: String,
    pub git: bool,
    pub agent: String,
    pub claude_internet: bool,
    pub claude_skip_permissions: bool,
    pub conda_env: String,
}

pub fn list_projects(conn: &Connection) -> Vec<Project> {
    let mut stmt = conn
        .prepare("SELECT name, root_dir, git, agent, claude_internet, claude_skip_permissions, conda_env FROM projects ORDER BY name")
        .unwrap();
    stmt.query_map([], |row| {
        Ok(Project {
            name: row.get(0)?,
            root_dir: row.get(1)?,
            git: row.get::<_, i64>(2)? != 0,
            agent: row.get(3)?,
            claude_internet: row.get::<_, i64>(4)? != 0,
            claude_skip_permissions: row.get::<_, i64>(5)? != 0,
            conda_env: row.get(6)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn add_project(
    conn: &Connection,
    name: &str,
    root_dir: &str,
    git: bool,
    agent: &str,
    claude_internet: bool,
    claude_skip_permissions: bool,
    conda_env: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO projects (name, root_dir, git, agent, claude_internet, claude_skip_permissions, conda_env) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![name, root_dir, git as i64, agent, claude_internet as i64, claude_skip_permissions as i64, conda_env],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(ref err, _)
            if err.code == rusqlite::ffi::ErrorCode::ConstraintViolation =>
        {
            format!("Project '{name}' already exists")
        }
        _ => format!("Failed to add project: {e}"),
    })?;
    Ok(())
}

pub fn update_project(
    conn: &Connection,
    old_name: &str,
    name: &str,
    root_dir: &str,
    git: bool,
    agent: &str,
    claude_internet: bool,
    claude_skip_permissions: bool,
    conda_env: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE projects SET name = ?1, root_dir = ?2, git = ?3, agent = ?4, claude_internet = ?5, claude_skip_permissions = ?6, conda_env = ?7 WHERE name = ?8",
        rusqlite::params![name, root_dir, git as i64, agent, claude_internet as i64, claude_skip_permissions as i64, conda_env, old_name],
    )
    .map_err(|e| format!("Failed to update project: {e}"))?;
    // Update workspace references if name changed
    if old_name != name {
        conn.execute(
            "UPDATE workspaces SET project = ?1 WHERE project = ?2",
            rusqlite::params![name, old_name],
        )
        .ok();
    }
    Ok(())
}

pub fn remove_project(conn: &Connection, name: &str) {
    conn.execute("DELETE FROM projects WHERE name = ?1", rusqlite::params![name])
        .ok();
}

// -- Workspaces --

#[derive(Serialize, Clone)]
pub struct WorkspaceTab {
    pub id: i64,
    pub sort_order: i64,
    pub name: String,
    pub tab_type: String,
}

#[derive(Serialize, Clone)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub project: String,
    pub created_at: String,
    pub worktree_dir: Option<String>,
    pub status: String,
    pub tabs: Vec<WorkspaceTab>,
}

pub fn list_workspaces(conn: &Connection) -> Vec<Workspace> {
    let mut stmt = conn
        .prepare("SELECT id, name, project, created_at, worktree_dir, status FROM workspaces ORDER BY id")
        .unwrap();
    let mut workspaces: Vec<Workspace> = stmt.query_map([], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            project: row.get(2)?,
            created_at: row.get(3)?,
            worktree_dir: row.get(4)?,
            status: row.get(5)?,
            tabs: Vec::new(),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect();

    for ws in &mut workspaces {
        ws.tabs = list_workspace_tabs(conn, ws.id);
    }
    workspaces
}

pub fn get_workspace(conn: &Connection, id: i64) -> Option<Workspace> {
    conn.query_row(
        "SELECT id, name, project, created_at, worktree_dir, status FROM workspaces WHERE id = ?1",
        [id],
        |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                project: row.get(2)?,
                created_at: row.get(3)?,
                worktree_dir: row.get(4)?,
                status: row.get(5)?,
                tabs: Vec::new(),
            })
        },
    )
    .ok()
}

fn list_workspace_tabs(conn: &Connection, workspace_id: i64) -> Vec<WorkspaceTab> {
    let mut stmt = conn
        .prepare("SELECT id, sort_order, name, tab_type FROM workspace_tabs WHERE workspace_id = ?1 ORDER BY sort_order")
        .unwrap();
    stmt.query_map([workspace_id], |row| {
        Ok(WorkspaceTab {
            id: row.get(0)?,
            sort_order: row.get(1)?,
            name: row.get(2)?,
            tab_type: row.get(3)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn add_workspace(conn: &Connection, name: &str, project: &str, worktree_dir: Option<&str>, status: &str) -> Workspace {
    conn.execute(
        "INSERT INTO workspaces (name, project, worktree_dir, status) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, project, worktree_dir, status],
    )
    .expect("Failed to insert workspace");
    let id = conn.last_insert_rowid();
    let created_at: String = conn
        .query_row("SELECT created_at FROM workspaces WHERE id = ?1", [id], |row| row.get(0))
        .unwrap();
    Workspace { id, name: name.to_string(), project: project.to_string(), created_at, worktree_dir: worktree_dir.map(String::from), status: status.to_string(), tabs: Vec::new() }
}

pub fn rename_workspace(conn: &Connection, id: i64, name: &str) {
    conn.execute(
        "UPDATE workspaces SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .ok();
}

pub fn update_workspace_status(conn: &Connection, id: i64, status: &str, worktree_dir: Option<&str>) {
    conn.execute(
        "UPDATE workspaces SET status = ?1, worktree_dir = ?2 WHERE id = ?3",
        rusqlite::params![status, worktree_dir, id],
    )
    .ok();
}

pub fn add_workspace_tab(conn: &Connection, workspace_id: i64, name: &str, tab_type: &str) -> WorkspaceTab {
    let max_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM workspace_tabs WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .unwrap_or(-1);
    conn.execute(
        "INSERT INTO workspace_tabs (workspace_id, sort_order, name, tab_type) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![workspace_id, max_order + 1, name, tab_type],
    )
    .expect("Failed to insert workspace tab");
    let id = conn.last_insert_rowid();
    WorkspaceTab { id, sort_order: max_order + 1, name: name.to_string(), tab_type: tab_type.to_string() }
}

pub fn update_workspace_tab(conn: &Connection, tab_id: i64, name: &str) {
    conn.execute(
        "UPDATE workspace_tabs SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, tab_id],
    )
    .ok();
}

pub fn get_workspace_id_for_tab(conn: &Connection, tab_id: i64) -> Option<i64> {
    conn.query_row(
        "SELECT workspace_id FROM workspace_tabs WHERE id = ?1",
        [tab_id],
        |row| row.get(0),
    )
    .ok()
}

pub fn remove_workspace_tab(conn: &Connection, tab_id: i64) {
    conn.execute("DELETE FROM workspace_tabs WHERE id = ?1", [tab_id]).ok();
}

pub fn next_workspace_name(conn: &Connection, project: &str) -> String {
    let prefix = format!("{project}-");
    let mut stmt = conn
        .prepare("SELECT name FROM workspaces WHERE project = ?1")
        .unwrap();
    let max: u64 = stmt
        .query_map([project], |row| row.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .filter_map(|name| name.strip_prefix(&prefix).and_then(|s| s.parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    format!("{project}-{}", max + 1)
}

pub fn remove_workspace(conn: &Connection, id: i64) {
    conn.execute("DELETE FROM workspace_tabs WHERE workspace_id = ?1", [id]).ok();
    conn.execute("DELETE FROM workspaces WHERE id = ?1", [id]).ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_db() -> Connection {
        init_db(Path::new(":memory:"))
    }

    #[test]
    fn test_init_db_runs_all_migrations() {
        let conn = test_db();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_VERSION);
    }

    #[test]
    fn test_init_db_idempotent() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("agentdispatch_test_{}.db", std::process::id()));
        let _conn1 = init_db(&path);
        drop(_conn1);
        let conn2 = init_db(&path);
        let version: i64 = conn2
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_VERSION);
        drop(conn2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_migration_count_matches_version() {
        assert_eq!(MIGRATIONS.len(), CURRENT_VERSION as usize);
    }

    // -- Projects --

    #[test]
    fn test_add_and_list_projects() {
        let conn = test_db();
        assert!(list_projects(&conn).is_empty());

        add_project(&conn, "test", "/tmp", true, "Claude", false, false, "").unwrap();
        let projects = list_projects(&conn);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "test");
        assert_eq!(projects[0].root_dir, "/tmp");
        assert!(projects[0].git);
        assert_eq!(projects[0].agent, "Claude");
        assert!(!projects[0].claude_internet);
        assert!(!projects[0].claude_skip_permissions);
        assert_eq!(projects[0].conda_env, "");
    }

    #[test]
    fn test_add_project_all_fields() {
        let conn = test_db();
        add_project(&conn, "full", "/var", false, "Codex", true, true, "py310").unwrap();
        let p = &list_projects(&conn)[0];
        assert_eq!(p.name, "full");
        assert_eq!(p.root_dir, "/var");
        assert!(!p.git);
        assert_eq!(p.agent, "Codex");
        assert!(p.claude_internet);
        assert!(p.claude_skip_permissions);
        assert_eq!(p.conda_env, "py310");
    }

    #[test]
    fn test_add_project_duplicate_name() {
        let conn = test_db();
        add_project(&conn, "test", "/tmp", true, "Claude", false, false, "").unwrap();
        let result = add_project(&conn, "test", "/tmp", true, "Claude", false, false, "");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
    }

    #[test]
    fn test_update_project() {
        let conn = test_db();
        add_project(&conn, "test", "/tmp", true, "Claude", false, false, "").unwrap();
        update_project(&conn, "test", "renamed", "/var", false, "Codex", true, true, "py310").unwrap();

        let projects = list_projects(&conn);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "renamed");
        assert_eq!(projects[0].root_dir, "/var");
        assert!(!projects[0].git);
        assert_eq!(projects[0].agent, "Codex");
        assert!(projects[0].claude_internet);
        assert!(projects[0].claude_skip_permissions);
        assert_eq!(projects[0].conda_env, "py310");
    }

    #[test]
    fn test_update_project_cascades_to_workspaces() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        add_workspace(&conn, "ws1", "proj", None, "ready");

        update_project(&conn, "proj", "newproj", "/tmp", true, "Claude", false, false, "").unwrap();

        let workspaces = list_workspaces(&conn);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].project, "newproj");
    }

    #[test]
    fn test_update_project_same_name_no_cascade() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        add_workspace(&conn, "ws1", "proj", None, "ready");

        // Update with same name — should not break
        update_project(&conn, "proj", "proj", "/var", false, "Claude", false, false, "").unwrap();
        let ws = list_workspaces(&conn);
        assert_eq!(ws[0].project, "proj");
    }

    #[test]
    fn test_remove_project() {
        let conn = test_db();
        add_project(&conn, "test", "/tmp", true, "Claude", false, false, "").unwrap();
        assert_eq!(list_projects(&conn).len(), 1);
        remove_project(&conn, "test");
        assert!(list_projects(&conn).is_empty());
    }

    #[test]
    fn test_remove_nonexistent_project() {
        let conn = test_db();
        // Should not panic
        remove_project(&conn, "nope");
    }

    #[test]
    fn test_multiple_projects_sorted() {
        let conn = test_db();
        add_project(&conn, "zebra", "/tmp", true, "Claude", false, false, "").unwrap();
        add_project(&conn, "alpha", "/tmp", true, "Claude", false, false, "").unwrap();
        add_project(&conn, "mid", "/tmp", true, "Claude", false, false, "").unwrap();

        let projects = list_projects(&conn);
        assert_eq!(projects[0].name, "alpha");
        assert_eq!(projects[1].name, "mid");
        assert_eq!(projects[2].name, "zebra");
    }

    // -- Workspaces --

    #[test]
    fn test_add_and_list_workspaces() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();

        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        assert_eq!(ws.name, "ws1");
        assert_eq!(ws.project, "proj");
        assert_eq!(ws.status, "ready");
        assert!(ws.worktree_dir.is_none());
        assert!(!ws.created_at.is_empty());

        let workspaces = list_workspaces(&conn);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "ws1");
    }

    #[test]
    fn test_get_workspace() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");

        let fetched = get_workspace(&conn, ws.id).unwrap();
        assert_eq!(fetched.name, "ws1");
        assert_eq!(fetched.project, "proj");

        assert!(get_workspace(&conn, 99999).is_none());
    }

    #[test]
    fn test_workspace_with_worktree() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", Some("/tmp/wt"), "setting_up");
        assert_eq!(ws.worktree_dir.as_deref(), Some("/tmp/wt"));
        assert_eq!(ws.status, "setting_up");
    }

    #[test]
    fn test_rename_workspace() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "old", "proj", None, "ready");

        rename_workspace(&conn, ws.id, "new");
        let fetched = get_workspace(&conn, ws.id).unwrap();
        assert_eq!(fetched.name, "new");
    }

    #[test]
    fn test_update_workspace_status() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "setting_up");

        update_workspace_status(&conn, ws.id, "ready", Some("/tmp/wt"));
        let fetched = get_workspace(&conn, ws.id).unwrap();
        assert_eq!(fetched.status, "ready");
        assert_eq!(fetched.worktree_dir.as_deref(), Some("/tmp/wt"));
    }

    #[test]
    fn test_remove_workspace_cascades_tabs() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        add_workspace_tab(&conn, ws.id, "shell", "shell");
        add_workspace_tab(&conn, ws.id, "agent", "claude");

        remove_workspace(&conn, ws.id);
        assert!(get_workspace(&conn, ws.id).is_none());
        assert!(list_workspace_tabs(&conn, ws.id).is_empty());
    }

    #[test]
    fn test_workspaces_ordered_by_id() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws1 = add_workspace(&conn, "second", "proj", None, "ready");
        let ws2 = add_workspace(&conn, "first", "proj", None, "ready");

        let workspaces = list_workspaces(&conn);
        assert_eq!(workspaces.len(), 2);
        assert!(workspaces[0].id < workspaces[1].id);
        assert_eq!(workspaces[0].id, ws1.id);
        assert_eq!(workspaces[1].id, ws2.id);
    }

    // -- Tabs --

    #[test]
    fn test_workspace_tabs() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");

        let t1 = add_workspace_tab(&conn, ws.id, "shell", "shell");
        let t2 = add_workspace_tab(&conn, ws.id, "agent", "claude");

        assert_eq!(t1.sort_order, 0);
        assert_eq!(t2.sort_order, 1);
        assert_eq!(t1.name, "shell");
        assert_eq!(t1.tab_type, "shell");
        assert_eq!(t2.name, "agent");
        assert_eq!(t2.tab_type, "claude");

        // Tabs included in workspace listing
        let workspaces = list_workspaces(&conn);
        assert_eq!(workspaces[0].tabs.len(), 2);
        assert_eq!(workspaces[0].tabs[0].sort_order, 0);
        assert_eq!(workspaces[0].tabs[1].sort_order, 1);
    }

    #[test]
    fn test_update_workspace_tab() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        let tab = add_workspace_tab(&conn, ws.id, "old", "shell");

        update_workspace_tab(&conn, tab.id, "new");
        let tabs = list_workspace_tabs(&conn, ws.id);
        assert_eq!(tabs[0].name, "new");
    }

    #[test]
    fn test_remove_workspace_tab() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        let tab = add_workspace_tab(&conn, ws.id, "shell", "shell");

        remove_workspace_tab(&conn, tab.id);
        assert!(list_workspace_tabs(&conn, ws.id).is_empty());
    }

    #[test]
    fn test_get_workspace_id_for_tab() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        let tab = add_workspace_tab(&conn, ws.id, "shell", "shell");

        assert_eq!(get_workspace_id_for_tab(&conn, tab.id), Some(ws.id));
        assert_eq!(get_workspace_id_for_tab(&conn, 99999), None);
    }

    #[test]
    fn test_tab_sort_order_after_removal() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        let ws = add_workspace(&conn, "ws1", "proj", None, "ready");
        let t1 = add_workspace_tab(&conn, ws.id, "first", "shell");
        let _t2 = add_workspace_tab(&conn, ws.id, "second", "shell");

        remove_workspace_tab(&conn, t1.id);

        // New tab should get sort_order = max(existing) + 1 = 2
        let t3 = add_workspace_tab(&conn, ws.id, "third", "shell");
        assert_eq!(t3.sort_order, 2);
    }

    // -- next_workspace_name --

    #[test]
    fn test_next_workspace_name_empty() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        assert_eq!(next_workspace_name(&conn, "proj"), "proj-1");
    }

    #[test]
    fn test_next_workspace_name_increments() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();

        add_workspace(&conn, "proj-1", "proj", None, "ready");
        assert_eq!(next_workspace_name(&conn, "proj"), "proj-2");

        add_workspace(&conn, "proj-5", "proj", None, "ready");
        assert_eq!(next_workspace_name(&conn, "proj"), "proj-6");
    }

    #[test]
    fn test_next_workspace_name_ignores_non_numeric() {
        let conn = test_db();
        add_project(&conn, "proj", "/tmp", true, "Claude", false, false, "").unwrap();
        add_workspace(&conn, "proj-custom", "proj", None, "ready");
        assert_eq!(next_workspace_name(&conn, "proj"), "proj-1");
    }

    #[test]
    fn test_next_workspace_name_different_projects() {
        let conn = test_db();
        add_project(&conn, "a", "/tmp", true, "Claude", false, false, "").unwrap();
        add_project(&conn, "b", "/tmp", true, "Claude", false, false, "").unwrap();
        add_workspace(&conn, "a-3", "a", None, "ready");

        assert_eq!(next_workspace_name(&conn, "a"), "a-4");
        assert_eq!(next_workspace_name(&conn, "b"), "b-1");
    }
}
