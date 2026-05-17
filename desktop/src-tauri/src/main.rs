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
        std::env::set_var("CLAUDE_CONFIG_DIR", portable_dir.to_string_lossy().to_string());
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
    // 1. 如果外部已经设置了 CLAUDE_CONFIG_DIR 环境变量，我们不应该覆盖它，直接返回 None 让 main 保持原样
    if std::env::var("CLAUDE_CONFIG_DIR").is_ok() {
        return None;
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let mut default_portable = exe_dir.to_path_buf();
    default_portable.push("CLAUDE_CONFIG_DIR");

    // 辅助函数：读取 app-mode.json 获取模式和自定义便携路径
    fn get_mode_from_config(dir: &std::path::Path) -> Option<(String, Option<PathBuf>)> {
        let path = dir.join("app-mode.json");
        let data = std::fs::read_to_string(&path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;
        let mode = parsed.get("mode").and_then(|m| m.as_str()).unwrap_or("default").to_string();
        let portable_dir = parsed.get("portable_dir").and_then(|v| v.as_str()).map(PathBuf::from);
        Some((mode, portable_dir))
    }

    // 2. 优先检查便携目录本地的配置文件（保证移动便携版到新电脑依然生效，并能正确处理切回默认模式）
    if let Some((mode, portable_dir)) = get_mode_from_config(&default_portable) {
        if mode == "portable" {
            return Some(portable_dir.unwrap_or(default_portable.clone()));
        } else {
            return None; // 明确设置了 default，直接使用系统默认
        }
    }

    // 3. 检查系统全局配置
    #[cfg(target_os = "windows")]
    let system_config: Option<PathBuf> = std::env::var("APPDATA").ok().map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let system_config: Option<PathBuf> = std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(target_os = "linux")]
    let system_config: Option<PathBuf> = std::env::var("XDG_CONFIG_HOME")
        .ok().map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")));

    if let Some(ref sys_cfg) = system_config {
        // 修复：必须使用 Tauri 默认的 bundle identifier
        let app_subdir = sys_cfg.join("com.claude-code-haha.desktop");
        if let Some((mode, portable_dir)) = get_mode_from_config(&app_subdir) {
            if mode == "portable" {
                return Some(portable_dir.unwrap_or(default_portable.clone()));
            } else {
                return None; // 明确设置了 default
            }
        }
    }

    // 4. 自动检测：如果默认便携目录中已经存在数据文件，则自动进入便携模式
    fn dir_has_portable_data(dir: &std::path::Path) -> bool {
        if !dir.is_dir() {
            return false;
        }
        ["window-state.json", "terminal-config.json"]
            .iter()
            .any(|f| dir.join(f).is_file())
            || dir.join("Cache").is_dir()
            || dir.join("EBWebView").is_dir()
    }

    if dir_has_portable_data(&default_portable) {
        return Some(default_portable);
    }

    None
}
