use actix_web::{HttpResponse, get, web};
use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Clone, Serialize)]
pub struct UpdateBatch {
    pub build_hash: String,
}

pub type Tx = web::Data<broadcast::Sender<UpdateBatch>>;

const PAGE_HTML: &str = include_str!("../static/index.html");
const APP_JS: &str = include_str!("../static/app.js");
const APP_ICON_SVG: &str = "\
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'>\
<rect width='128' height='128' rx='24' fill='#172033'/>\
<rect x='12' y='12' width='104' height='104' rx='10' fill='#243447'/>\
<rect x='42' y='20' width='2' height='88' fill='#4b5f78'/>\
<rect x='18' y='24' width='18' height='11' rx='4' fill='#a5b4fc'/>\
<rect x='18' y='41' width='18' height='11' rx='4' fill='#4b5f78'/>\
<rect x='18' y='58' width='18' height='11' rx='4' fill='#4b5f78'/>\
<rect x='18' y='75' width='18' height='11' rx='4' fill='#4b5f78'/>\
<rect x='50' y='24' width='58' height='7' rx='3' fill='#7dd3fc' opacity='0.9'/>\
<rect x='50' y='38' width='46' height='7' rx='3' fill='#64748b'/>\
<rect x='50' y='52' width='54' height='7' rx='3' fill='#64748b'/>\
<rect x='50' y='66' width='38' height='7' rx='3' fill='#a5b4fc' opacity='0.65'/>\
<rect x='50' y='82' width='50' height='7' rx='3' fill='#64748b' opacity='0.9'/>\
</svg>";

pub fn build_hash() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    PAGE_HTML.hash(&mut hasher);
    APP_JS.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub type BuildHash = web::Data<String>;

#[derive(Serialize)]
struct InitPayload {
    build_hash: String,
}

#[get("/icon.svg")]
pub async fn icon() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("image/svg+xml")
        .body(APP_ICON_SVG)
}

#[get("/")]
pub async fn index() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html")
        .body(PAGE_HTML)
}

#[get("/app.js")]
pub async fn app_js() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/javascript")
        .body(APP_JS)
}

#[get("/api/events")]
pub async fn events(
    tx: Tx,
    hash: BuildHash,
) -> HttpResponse {
    let init = InitPayload { build_hash: hash.as_ref().clone() };
    let init_data = serde_json::to_string(&init).unwrap();
    let mut rx = tx.subscribe();

    let stream = async_stream::stream! {
        // Send initial state
        yield Ok::<_, actix_web::Error>(
            web::Bytes::from(format!("event: init\ndata: {}\n\n", init_data))
        );

        // Stream updates with periodic heartbeat
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
        heartbeat.tick().await; // consume immediate first tick

        loop {
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(batch) => {
                            if let Ok(s) = serde_json::to_string(&batch) {
                                yield Ok(web::Bytes::from(format!("event: update\ndata: {}\n\n", s)));
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("SSE client lagged, missed {} messages", n);
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = heartbeat.tick() => {
                    yield Ok(web::Bytes::from(": heartbeat\n\n"));
                }
            }
        }
    };

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::App;

    #[test]
    fn test_build_hash_deterministic() {
        let h1 = build_hash();
        let h2 = build_hash();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
    }

    #[test]
    fn test_build_hash_is_hex() {
        let h = build_hash();
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[actix_web::test]
    async fn test_index_returns_html() {
        let app = actix_web::test::init_service(App::new().service(index)).await;
        let req = actix_web::test::TestRequest::get().uri("/").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/html"
        );
    }

    #[actix_web::test]
    async fn test_index_contains_doctype() {
        let app = actix_web::test::init_service(App::new().service(index)).await;
        let req = actix_web::test::TestRequest::get().uri("/").to_request();
        let body = actix_web::test::call_and_read_body(&app, req).await;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("<!DOCTYPE html>"));
    }

    #[actix_web::test]
    async fn test_icon_returns_svg() {
        let app = actix_web::test::init_service(App::new().service(icon)).await;
        let req = actix_web::test::TestRequest::get().uri("/icon.svg").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "image/svg+xml"
        );
    }

    #[actix_web::test]
    async fn test_icon_contains_svg_element() {
        let app = actix_web::test::init_service(App::new().service(icon)).await;
        let req = actix_web::test::TestRequest::get().uri("/icon.svg").to_request();
        let body = actix_web::test::call_and_read_body(&app, req).await;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("<svg"));
    }

    #[actix_web::test]
    async fn test_app_js_returns_javascript() {
        let app = actix_web::test::init_service(App::new().service(app_js)).await;
        let req = actix_web::test::TestRequest::get().uri("/app.js").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/javascript"
        );
    }

    #[actix_web::test]
    async fn test_app_js_contains_functions() {
        let app = actix_web::test::init_service(App::new().service(app_js)).await;
        let req = actix_web::test::TestRequest::get().uri("/app.js").to_request();
        let body = actix_web::test::call_and_read_body(&app, req).await;
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("function getProjectAgent("));
        assert!(text.contains("function getTerminalConfig("));
        assert!(text.contains("function buildAgentCommand("));
    }

    #[test]
    fn test_js_unit_tests() {
        let output = std::process::Command::new("node")
            .args(["--test", "static/app.test.js"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output();
        let output = output.expect("node is required to run JS tests");
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            panic!("JS tests failed:\n{stdout}\n{stderr}");
        }
    }

    macro_rules! e2e_file_test {
        ($name:ident, $file:expr) => {
            #[test]
            fn $name() {
                run_playwright(&[concat!("e2e/", $file, ".test.js")]);
            }
        };
    }

    e2e_file_test!(test_e2e_altscreen, "altscreen");
    e2e_file_test!(test_e2e_altscreen_keys, "altscreen-keys");
    e2e_file_test!(test_e2e_altscreen_mouse, "altscreen-mouse");
    e2e_file_test!(test_e2e_altscreen_reconnect, "altscreen-reconnect");
    e2e_file_test!(test_e2e_capture_fallback, "capture-fallback");
    e2e_file_test!(test_e2e_claude_reconnect, "claude-reconnect");
    e2e_file_test!(test_e2e_claude_redraw, "claude-redraw");
    e2e_file_test!(test_e2e_claude_scroll_jump, "claude-scroll-jump");
    e2e_file_test!(test_e2e_git_checkbox, "git-checkbox");
    e2e_file_test!(test_e2e_launch, "launch");
    e2e_file_test!(test_e2e_pane_resize, "pane-resize");
    e2e_file_test!(test_e2e_scroll, "scroll");
    e2e_file_test!(test_e2e_scroll_isolation, "scroll-isolation");
    e2e_file_test!(test_e2e_scrollback_clear, "scrollback-clear");
    e2e_file_test!(test_e2e_sync_scroll, "sync-scroll");
    e2e_file_test!(test_e2e_viewport, "viewport");

    fn run_playwright(args: &[&str]) {

        let mut cmd_args = vec!["60", "npx", "playwright", "test"];
        cmd_args.extend(args);

        let output = std::process::Command::new("timeout")
            .args(&cmd_args)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .expect("timeout/npx is required to run E2E tests");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stdout.contains("failed") || (!output.status.success() && !stdout.contains("passed")) {
            panic!("E2E tests failed:\n{stdout}\n{stderr}");
        }
    }

    #[actix_web::test]
    async fn test_events_returns_sse() {
        let (tx, _) = tokio::sync::broadcast::channel::<UpdateBatch>(16);
        let tx_data = actix_web::web::Data::new(tx);
        let hash_data = actix_web::web::Data::new(build_hash());

        let app = actix_web::test::init_service(
            App::new()
                .app_data(tx_data)
                .app_data(hash_data)
                .service(events),
        )
        .await;

        let req = actix_web::test::TestRequest::get().uri("/api/events").to_request();
        let resp = actix_web::test::call_service(&app, req).await;
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/event-stream"
        );
        assert_eq!(
            resp.headers().get("cache-control").unwrap(),
            "no-cache"
        );
    }
}
