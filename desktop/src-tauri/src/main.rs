// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

fn main() {
    // Determine if we should start in portable mode and set CLAUDE_CONFIG_DIR
    // before any Tauri/WebView2 initialization.
    //
    // Mode resolution order:
    //   1. External CLAUDE_CONFIG_DIR env var (batch script etc.) — always respected
    //   2. Persisted app-mode.json saying "portable"
    //   3. Auto-detect: default portable dir already has data files
    //
    // In "default" mode the app does NOT set CLAUDE_CONFIG_DIR itself.
    // It relies on the env var (if set externally) or falls back to system dirs.
    // All existing std::env::var("CLAUDE_CONFIG_DIR") checks in lib.rs handle this.

    if let Some(portable_dir) = determine_startup_portable_dir() {
        std::env::set_var(
            "CLAUDE_CONFIG_DIR",
            portable_dir.to_string_lossy().to_string(),
        );
        std::env::set_var("CC_HAHA_APP_PORTABLE_DIR", "1");
    }

    // If CLAUDE_CONFIG_DIR is set (either from env or from our startup logic above),
    // redirect WebView2 user data folder so EBWebView cache lives alongside it.
    if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let webview_data = PathBuf::from(&config_dir).join("EBWebView");
        if let Err(e) = fs::create_dir_all(&webview_data) {
            eprintln!("[desktop] failed to create EBWebView dir: {e}");
        }
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data);
    }

    claude_code_desktop_lib::run()
}

/// Determine if we should start in portable mode.
/// Returns the portable config directory path if yes, None for default mode.
fn determine_startup_portable_dir() -> Option<PathBuf> {
    // 1. If CLAUDE_CONFIG_DIR is already set externally, do not override it; return None so main leaves it as is
    if std::env::var("CLAUDE_CONFIG_DIR").is_ok() {
        return None;
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let mut default_portable = exe_dir.to_path_buf();
    default_portable.push("CLAUDE_CONFIG_DIR");

    // Helper: read app-mode.json for the mode and custom portable path
    fn get_mode_from_config(dir: &std::path::Path) -> Option<(String, Option<PathBuf>)> {
        let path = dir.join("app-mode.json");
        let data = std::fs::read_to_string(&path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;
        let mode = parsed
            .get("mode")
            .and_then(|m| m.as_str())
            .unwrap_or("default")
            .to_ascii_lowercase();
        let portable_dir = parsed
            .get("portable_dir")
            .and_then(|v| v.as_str())
            .map(PathBuf::from);
        Some((mode, portable_dir))
    }

    // 2. Check the config file in the portable directory first (so a portable copy moved to a new machine keeps working and switching back to default mode is handled)
    if let Some((mode, portable_dir)) = get_mode_from_config(&default_portable) {
        if mode == "portable" {
            if dir_has_portable_data(&default_portable) {
                return Some(default_portable.clone());
            }
            return Some(portable_dir.unwrap_or(default_portable.clone()));
        } else {
            return None; // default set explicitly; use the system default
        }
    }

    // 3. Check the system-wide config
    #[cfg(target_os = "windows")]
    let system_config: Option<PathBuf> = std::env::var("APPDATA").ok().map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let system_config: Option<PathBuf> = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(target_os = "linux")]
    let system_config: Option<PathBuf> = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".config"))
        });

    if let Some(ref sys_cfg) = system_config {
        // Fix: must use the Tauri default bundle identifier
        let app_subdir = sys_cfg.join("com.claude-code-haha.desktop");
        if let Some((mode, portable_dir)) = get_mode_from_config(&app_subdir) {
            if mode == "portable" {
                return Some(portable_dir.unwrap_or(default_portable.clone()));
            } else {
                return None; // default set explicitly
            }
        }
    }

    // 4. Auto-detect: if the default portable directory already has data files, enter portable mode
    fn dir_has_portable_data(dir: &std::path::Path) -> bool {
        if !dir.is_dir() {
            return false;
        }
        [
            "settings.json",
            ".claude.json",
            ".mcp.json",
            "window-state.json",
            "terminal-config.json",
        ]
            .iter()
            .any(|f| dir.join(f).is_file())
            || dir.join("Cache").is_dir()
            || dir.join("EBWebView").is_dir()
            || dir.join("projects").is_dir()
            || dir.join("skills").is_dir()
            || dir.join("plugins").is_dir()
            || dir.join("cowork_plugins").is_dir()
            || dir.join("cc-haha").is_dir()
    }

    if dir_has_portable_data(&default_portable) {
        return Some(default_portable);
    }

    None
}
