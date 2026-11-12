use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewBuilder, WebviewUrl};

const PREVIEW_LABEL: &str = "preview";

const PREVIEW_INIT_SCRIPT: &str = include_str!("../resources/preview-agent.js");
const PREVIEW_TAURI_BRIDGE_SCRIPT: &str = r#"
window.__DESKTOP_PREVIEW_POST__ = function(raw) {
  var internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') {
    internals.invoke('preview_message', { raw: raw });
  }
};
"#;

#[derive(Default)]
pub struct PreviewState(Mutex<PreviewInner>);

#[derive(Default)]
struct PreviewInner {
    created: bool,
}

#[derive(serde::Deserialize)]
pub struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Only http/https are allowed; anything else (file:, javascript:, ...) is rejected. Returns the normalized URL string.
pub fn normalize_preview_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Err(format!("unsupported url scheme: {trimmed}"))
    }
}

#[tauri::command]
pub async fn preview_open<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, PreviewState>,
    url: String,
    bounds: PreviewBounds,
) -> Result<(), String> {
    let normalized = normalize_preview_url(&url)?;
    let target = tauri::Url::parse(&normalized).map_err(|e| e.to_string())?;

    if let Some(webview) = app.get_webview(PREVIEW_LABEL) {
        webview.navigate(target).map_err(|e| e.to_string())?;
        webview
            .set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // `add_child` lives on `Window<R>`, not `WebviewWindow<R>`; `get_window`
    // (unstable, enabled) returns the underlying `Window` for the same OS window.
    let main = app
        .get_window(crate::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let init_script = format!("{PREVIEW_TAURI_BRIDGE_SCRIPT}\n{PREVIEW_INIT_SCRIPT}");
    let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(target))
        .initialization_script_for_all_frames(init_script);
    main.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    )
    .map_err(|e| e.to_string())?;

    state.0.lock().unwrap().created = true;
    Ok(())
}

#[tauri::command]
pub async fn preview_navigate<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let normalized = normalize_preview_url(&url)?;
    let target = tauri::Url::parse(&normalized).map_err(|e| e.to_string())?;
    let webview = app
        .get_webview(PREVIEW_LABEL)
        .ok_or_else(|| "preview not open".to_string())?;
    webview.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    bounds: PreviewBounds,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(PREVIEW_LABEL) else {
        return Ok(());
    };
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn preview_set_visible<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(PREVIEW_LABEL) else {
        return Ok(());
    };
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn preview_close<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, PreviewState>,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(PREVIEW_LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    state.0.lock().unwrap().created = false;
    Ok(())
}

/// Page → host: the injected script calls this command over IPC; Rust validates and forwards it to the frontend.
#[tauri::command]
pub fn preview_message<R: Runtime>(app: AppHandle<R>, raw: String) -> Result<(), String> {
    // Forward only the JSON string; the frontend parses it with strong types (schema validation lives in the TS protocol)
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())?;
    app.emit("preview://event", raw).map_err(|e| e.to_string())
}

/// Host → page: eval a JS snippet inside the child webview.
#[tauri::command]
pub async fn preview_eval<R: Runtime>(app: AppHandle<R>, js: String) -> Result<(), String> {
    let webview = app.get_webview(PREVIEW_LABEL).ok_or_else(|| "preview not open".to_string())?;
    webview.eval(&js).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert_eq!(normalize_preview_url("http://localhost:5173/").unwrap(), "http://localhost:5173/");
        assert_eq!(normalize_preview_url("https://example.com").unwrap(), "https://example.com");
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(normalize_preview_url("  http://127.0.0.1:8080  ").unwrap(), "http://127.0.0.1:8080");
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(normalize_preview_url("file:///etc/passwd").is_err());
        assert!(normalize_preview_url("javascript:alert(1)").is_err());
        assert!(normalize_preview_url("").is_err());
    }
}
