use std::sync::{Arc, Mutex};

use actix_web::{HttpResponse, delete, get, post, put, web};
use rusqlite::Connection;
use serde::Deserialize;

use crate::db;
use crate::terminal::UseTmux;
use crate::tmux;

pub type Db = web::Data<Arc<Mutex<Connection>>>;

#[derive(Deserialize)]
pub struct NewWorkspaceRequest {
    #[serde(default)]
    name: Option<String>,
}

#[post("/api/workspaces")]
pub async fn create_workspace(
    db: Db,
    body: web::Json<NewWorkspaceRequest>,
    use_tmux: UseTmux,
) -> HttpResponse {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let ws = {
        let conn = db.lock().unwrap();
        let ws_name = body.name.as_ref()
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.trim().to_string())
            .unwrap_or_else(|| db::next_workspace_name(&conn, "ws"));
        let ws = db::add_workspace(&conn, &ws_name, "", None, "ready", "", "");
        let tab = db::add_workspace_tab(&conn, ws.id, "shell", "shell");
        (ws, tab)
    };
    let (ws, tab) = ws;

    if **use_tmux {
        let tmux_session = format!("ws-{}", ws.id);
        let tmux_window = format!("tab-{}", tab.id);
        if let Err(e) = tmux::new_session(&tmux_session, &tmux_window, &home, None) {
            tlog!("Failed to create tmux session for workspace {}: {e}", ws.id);
        }
    }

    HttpResponse::Ok().json(ws)
}

#[get("/api/workspaces")]
pub async fn list_workspaces(db: Db, use_tmux: UseTmux) -> HttpResponse {
    let conn = db.lock().unwrap();

    if **use_tmux {
        adopt_orphan_windows(&conn);
    }

    let workspaces = db::list_workspaces(&conn);
    let categories = db::list_categories(&conn);
    HttpResponse::Ok().json(serde_json::json!({
        "workspaces": workspaces,
        "categories": categories,
    }))
}

#[derive(Deserialize)]
pub struct CreateCategoryRequest {
    name: String,
}

#[post("/api/categories")]
pub async fn create_category(db: Db, body: web::Json<CreateCategoryRequest>) -> HttpResponse {
    let conn = db.lock().unwrap();
    let cat = db::add_category(&conn, &body.name);
    HttpResponse::Ok().json(cat)
}

#[derive(Deserialize)]
pub struct RenameCategoryRequest {
    name: String,
}

#[put("/api/categories/{id}")]
pub async fn rename_category(db: Db, path: web::Path<i64>, body: web::Json<RenameCategoryRequest>) -> HttpResponse {
    let id = path.into_inner();
    let conn = db.lock().unwrap();
    db::rename_category(&conn, id, &body.name);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

#[delete("/api/categories/{id}")]
pub async fn delete_category(db: Db, path: web::Path<i64>) -> HttpResponse {
    let id = path.into_inner();
    let conn = db.lock().unwrap();
    db::delete_category(&conn, id);
    HttpResponse::Ok().json(serde_json::json!({"status": "removed"}))
}

#[derive(Deserialize)]
pub struct ReorderCategoriesRequest {
    ids: Vec<i64>,
}

#[post("/api/categories/reorder")]
pub async fn reorder_categories(db: Db, body: web::Json<ReorderCategoriesRequest>) -> HttpResponse {
    let conn = db.lock().unwrap();
    db::reorder_categories(&conn, &body.ids);
    HttpResponse::Ok().json(serde_json::json!({"status": "reordered"}))
}

#[derive(Deserialize)]
pub struct ToggleCategoryRequest {
    collapsed: bool,
}

#[post("/api/categories/{id}/toggle")]
pub async fn toggle_category(db: Db, path: web::Path<i64>, body: web::Json<ToggleCategoryRequest>) -> HttpResponse {
    let id = path.into_inner();
    let conn = db.lock().unwrap();
    db::set_category_collapsed(&conn, id, body.collapsed);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

#[derive(Deserialize)]
pub struct SetWorkspaceCategoryRequest {
    category_id: Option<i64>,
}

#[post("/api/workspaces/{id}/category")]
pub async fn set_workspace_category(db: Db, path: web::Path<i64>, body: web::Json<SetWorkspaceCategoryRequest>) -> HttpResponse {
    let id = path.into_inner();
    let conn = db.lock().unwrap();
    db::set_workspace_category(&conn, id, body.category_id);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

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

#[delete("/api/workspaces/{id}")]
pub async fn delete_workspace(
    db: Db,
    path: web::Path<i64>,
) -> HttpResponse {
    let id = path.into_inner();

    tmux::kill_session(&format!("ws-{id}"));
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

fn default_shell() -> String { "shell".to_string() }

#[post("/api/workspaces/{id}/tabs")]
pub async fn create_tab(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<CreateTabRequest>,
    use_tmux: UseTmux,
) -> HttpResponse {
    let ws_id = path.into_inner();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let tab = {
        let conn = db.lock().unwrap();
        db::add_workspace_tab(&conn, ws_id, &body.name, &body.tab_type)
    };

    if **use_tmux {
        let tmux_session = format!("ws-{ws_id}");
        let tmux_window = format!("tab-{}", tab.id);
        if tmux::has_session(&tmux_session) {
            let cwd = tmux::first_pane_cwd(&tmux_session).unwrap_or(home);
            if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, &cwd, None) {
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
    {
        let conn = db.lock().unwrap();
        if db::get_workspace(&conn, ws_id).is_none() {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "workspace not found"}));
        }
    }

    if !**use_tmux {
        return HttpResponse::Ok().json(serde_json::json!({"status": "ok"}));
    }

    let tmux_session = format!("ws-{ws_id}");
    tmux::kill_session(&tmux_session);

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let tabs = {
        let conn = db.lock().unwrap();
        db::list_workspace_tabs(&conn, ws_id)
    };
    for tab in &tabs {
        let tmux_window = format!("tab-{}", tab.id);
        if tmux::has_session(&tmux_session) {
            if let Err(e) = tmux::new_window(&tmux_session, &tmux_window, &home, None) {
                tlog!("Failed to recreate tmux window tab-{}: {e}", tab.id);
            }
        } else if let Err(e) = tmux::new_session(&tmux_session, &tmux_window, &home, None) {
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
}

#[post("/api/workspaces/reorder")]
pub async fn reorder_workspaces(
    db: Db,
    body: web::Json<ReorderRequest>,
) -> HttpResponse {
    let conn = db.lock().unwrap();
    db::reorder_workspaces(&conn, &body.ids);
    HttpResponse::Ok().json(serde_json::json!({"status": "reordered"}))
}

#[post("/api/workspaces/{id}/tabs/reorder")]
pub async fn reorder_tabs(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<ReorderRequest>,
) -> HttpResponse {
    let _ws_id = path.into_inner();
    let conn = db.lock().unwrap();
    db::reorder_tabs(&conn, &body.ids);
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

#[derive(Deserialize)]
pub struct SetMouseWheelRequest {
    enabled: bool,
}

#[post("/api/tabs/{id}/mouse-wheel-fs")]
pub async fn set_tab_mouse_wheel(
    db: Db,
    path: web::Path<i64>,
    body: web::Json<SetMouseWheelRequest>,
) -> HttpResponse {
    let tab_id = path.into_inner();
    let conn = db.lock().unwrap();
    db::set_tab_mouse_wheel_fs(&conn, tab_id, body.enabled);
    HttpResponse::Ok().json(serde_json::json!({"status": "updated"}))
}

#[delete("/api/tabs/{id}")]
pub async fn delete_tab(
    db: Db,
    path: web::Path<i64>,
) -> HttpResponse {
    let tab_id = path.into_inner();
    let conn = db.lock().unwrap();
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

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::App;
    use std::sync::{Arc, Mutex};

    fn test_app_data() -> actix_web::web::Data<Arc<Mutex<rusqlite::Connection>>> {
        let conn = crate::db::init_db(std::path::Path::new(":memory:"));
        actix_web::web::Data::new(Arc::new(Mutex::new(conn)))
    }

    fn test_tmux_data() -> actix_web::web::Data<bool> {
        actix_web::web::Data::new(false)
    }

    fn extract_workspaces(body: serde_json::Value) -> Vec<serde_json::Value> {
        body["workspaces"].as_array().cloned().unwrap_or_default()
    }

    #[actix_web::test]
    async fn test_create_workspace() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(create_workspace)
                .service(list_workspaces),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/workspaces")
            .set_json(serde_json::json!({}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["name"], "ws-1");
        assert_eq!(resp["status"], "ready");

        let req = actix_web::test::TestRequest::get()
            .uri("/api/workspaces")
            .to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert_eq!(resp.len(), 1);
        assert_eq!(resp[0]["tabs"].as_array().unwrap().len(), 1);
    }

    #[actix_web::test]
    async fn test_create_workspace_custom_name() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(create_workspace),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/workspaces")
            .set_json(serde_json::json!({"name": "my-ws"}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        assert_eq!(resp["name"], "my-ws");
    }

    #[actix_web::test]
    async fn test_workspace_rename() {
        let db = test_app_data();
        let app = actix_web::test::init_service(
            App::new()
                .app_data(db.clone())
                .app_data(test_tmux_data())
                .service(create_workspace)
                .service(rename_workspace)
                .service(list_workspaces),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/workspaces")
            .set_json(serde_json::json!({}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        let ws_id = resp["id"].as_i64().unwrap();

        let req = actix_web::test::TestRequest::put()
            .uri(&format!("/api/workspaces/{ws_id}"))
            .set_json(serde_json::json!({"name": "renamed"}))
            .to_request();
        assert!(actix_web::test::call_service(&app, req).await.status().is_success());

        let req = actix_web::test::TestRequest::get().uri("/api/workspaces").to_request();
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
                .service(create_workspace)
                .service(create_tab)
                .service(update_tab)
                .service(delete_tab)
                .service(list_workspaces),
        )
        .await;

        let req = actix_web::test::TestRequest::post()
            .uri("/api/workspaces")
            .set_json(serde_json::json!({}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        let ws_id = resp["id"].as_i64().unwrap();

        // Create tab
        let req = actix_web::test::TestRequest::post()
            .uri(&format!("/api/workspaces/{ws_id}/tabs"))
            .set_json(serde_json::json!({"name": "shell2", "tab_type": "shell"}))
            .to_request();
        let resp: serde_json::Value = actix_web::test::call_and_read_body_json(&app, req).await;
        let tab_id = resp["id"].as_i64().unwrap();

        // Update tab
        let req = actix_web::test::TestRequest::put()
            .uri(&format!("/api/tabs/{tab_id}"))
            .set_json(serde_json::json!({"name": "renamed"}))
            .to_request();
        assert!(actix_web::test::call_service(&app, req).await.status().is_success());

        // Delete tab
        let req = actix_web::test::TestRequest::delete()
            .uri(&format!("/api/tabs/{tab_id}"))
            .to_request();
        assert!(actix_web::test::call_service(&app, req).await.status().is_success());

        // Workspace should still have the initial shell tab
        let req = actix_web::test::TestRequest::get().uri("/api/workspaces").to_request();
        let resp = extract_workspaces(actix_web::test::call_and_read_body_json(&app, req).await);
        assert_eq!(resp[0]["tabs"].as_array().unwrap().len(), 1);
    }
}
