use clap::{Args, Parser};
use serde::Deserialize;

use super::{Surface, WindowScope};

fn default_launch_timeout() -> u64 {
    30000
}

fn default_wait_timeout() -> u64 {
    30000
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LaunchArgs {
    #[arg(value_name = "APP", help = "Application name or bundle ID")]
    pub app: String,
    #[arg(
        long,
        default_value = "30000",
        help = "Upper bound in ms for the whole launch"
    )]
    #[serde(default = "default_launch_timeout")]
    pub timeout: u64,
    #[arg(
        long = "arg",
        allow_hyphen_values = true,
        help = "Command-line argument passed to the launched app; repeatable, order preserved. \
                For values starting with '-', use --arg=<value>"
    )]
    #[serde(default)]
    pub args: Vec<String>,
    #[arg(
        long = "env",
        value_name = "KEY=VALUE",
        help = "Environment variable for the launched process"
    )]
    #[serde(default)]
    pub env: Vec<String>,
    #[arg(long, help = "Working directory for the launched process")]
    pub cwd: Option<std::path::PathBuf>,
    #[arg(
        long = "no-attach",
        help = "Start a fresh instance instead of attaching to a running one (Windows fails if the app is already running)"
    )]
    #[serde(default)]
    pub no_attach: bool,
    #[arg(
        long,
        help = "Bring the app forward so it presents a window, and wait for one"
    )]
    #[serde(default)]
    pub activate: bool,
    #[arg(
        long,
        value_name = "PORT",
        num_args = 0..=1,
        default_missing_value = "0",
        help = "Expose the app's DevTools protocol endpoint on this port (0 or omitted picks a free port)"
    )]
    #[serde(default)]
    pub cdp: Option<u16>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CloseAppArgs {
    #[arg(value_name = "APP", help = "Application name")]
    pub app: String,
    #[arg(
        long,
        help = "Terminate matching app processes instead of quitting gracefully"
    )]
    #[serde(default)]
    pub force: bool,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListWindowsArgs {
    #[arg(long, help = "Filter to application by exact case-insensitive name")]
    pub app: Option<String>,
    #[arg(
        long,
        value_name = "MS",
        help = "Inventory deadline in milliseconds (default 5000)"
    )]
    pub timeout_ms: Option<u64>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListAppsArgs {
    #[arg(long, help = "Filter to application by name")]
    pub app: Option<String>,
    #[arg(
        long,
        value_name = "MS",
        help = "Inventory deadline in milliseconds (default 5000)"
    )]
    pub timeout_ms: Option<u64>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FocusWindowArgs {
    #[arg(long, name = "window-id", help = "Window ID from list-windows")]
    pub window_id: Option<String>,
    #[arg(long, help = "Application name")]
    pub app: Option<String>,
    #[arg(long, help = "Window title (partial match accepted)")]
    pub title: Option<String>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResizeWindowCliArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[arg(long, help = "New window width in pixels")]
    pub width: f64,
    #[arg(long, help = "New window height in pixels")]
    pub height: f64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveWindowCliArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[arg(
        long,
        help = "New window X position; write a negative value with = (--x=-100)"
    )]
    pub x: f64,
    #[arg(
        long,
        help = "New window Y position; write a negative value with = (--y=-100)"
    )]
    pub y: f64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppRefArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClipboardGetArgs {
    #[arg(
        long,
        value_name = "FORMAT",
        help = "Clipboard format to read: text (default), auto, image, file-urls"
    )]
    pub format: Option<String>,
    #[arg(
        long,
        value_name = "PATH",
        help = "Where to write image content; defaults to a private temp file under the session dir"
    )]
    pub out: Option<std::path::PathBuf>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClipboardSetArgs {
    #[arg(
        value_name = "TEXT",
        help = "Text to write to the clipboard (ignored if --image or --file-url is given)"
    )]
    pub text: Option<String>,
    #[arg(
        long,
        value_name = "PATH",
        help = "Path to a PNG file to write to the clipboard"
    )]
    pub image: Option<std::path::PathBuf>,
    #[arg(
        long = "file-url",
        value_name = "PATH",
        help = "File path to write to the clipboard as a file reference; repeatable"
    )]
    #[serde(default)]
    pub file_url: Vec<String>,
}

/// `event`/`window_id` flatten in as a sibling of `mode`/`predicate` here
/// (not nested inside [`WaitModeArgs`]) even though they are conceptually
/// part of the wait mode: serde does not support `#[serde(deny_unknown_fields)]`
/// on a struct that is both a flatten *target* and a flatten *owner*, and
/// every struct in this file needs `deny_unknown_fields` to keep rejecting
/// typoed batch-JSON keys. Keeping the flatten nesting at exactly one level
/// (three flatten fields side by side, mirroring the existing `mode`/
/// `predicate` split) sidesteps that limitation; the CLI surface is
/// unaffected since `#[command(flatten)]` merges flags regardless of Rust
/// struct nesting depth.
#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WaitArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub mode: WaitModeArgs,
    #[command(flatten)]
    #[serde(flatten)]
    pub event: WaitEventArgs,
    #[command(flatten)]
    #[serde(flatten)]
    pub predicate: WaitPredicateArgs,
    #[arg(
        long,
        default_value = "30000",
        help = "Timeout in milliseconds for element/window/text waits"
    )]
    #[serde(default = "default_wait_timeout")]
    pub timeout: u64,
    #[arg(long, help = "Scope element, window, or text wait to this application")]
    pub app: Option<String>,
}

/// The `--event`/`--window-id` pair, grouped out of [`WaitModeArgs`] to keep
/// it under the repo's field-count limit. `window_id` only ever narrows an
/// `--event` wait, so the two travel together.
#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WaitEventArgs {
    #[arg(
        long,
        help = "Block until a desktop lifecycle signal, detected by baseline diff without needing to know the id/title up front: window-opened, window-closed, app-launched, app-terminated, focus-changed, surface-appeared, surface-dismissed"
    )]
    pub event: Option<String>,
    #[arg(
        long,
        name = "window-id",
        help = "Optional: narrow --event window-opened/window-closed/focus-changed to one window ID"
    )]
    pub window_id: Option<String>,
}

#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WaitModeArgs {
    #[arg(value_name = "MS", help = "Milliseconds to pause")]
    pub ms: Option<u64>,
    #[arg(long, help = "Block until this element ref appears in the tree")]
    pub element: Option<String>,
    #[arg(
        long,
        help = "Block until a window with this title appears; with --event, narrows the event wait to that window title instead of selecting a mode"
    )]
    pub window: Option<String>,
    #[arg(
        long,
        help = "Block until text appears in the app's accessibility tree; with --notification, filter notification text"
    )]
    pub text: Option<String>,
    #[arg(long, help = "Block until a menu surface is open")]
    #[serde(default)]
    pub menu: bool,
    #[arg(long, help = "Block until the menu surface is dismissed")]
    #[serde(default)]
    pub menu_closed: bool,
    #[arg(long, help = "Block until a new notification arrives")]
    #[serde(default)]
    pub notification: bool,
}

#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WaitPredicateArgs {
    #[arg(
        long,
        value_name = "PREDICATE",
        help = "Element wait predicate: exists, enabled, visible, actionable, or value"
    )]
    pub predicate: Option<String>,
    #[arg(
        long,
        value_name = "VALUE",
        help = "Expected value for --predicate value"
    )]
    pub value: Option<String>,
    #[arg(
        long,
        value_name = "ACTION",
        help = "Action for --predicate actionable: click (default), type, set-value, or clear"
    )]
    pub action: Option<String>,
    #[arg(
        long,
        value_name = "COUNT",
        help = "Expected match count for --text waits"
    )]
    pub count: Option<usize>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpenSystemSurfaceArgs {
    #[arg(
        long,
        value_enum,
        help = "Shell surface to open: start-menu, taskbar, system-tray, system-tray-overflow, action-center"
    )]
    pub surface: Surface,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PermissionsArgs {
    #[arg(
        long,
        help = "Request missing permissions in the bounded isolated helper"
    )]
    #[serde(default)]
    pub request: bool,
    #[arg(
        long,
        help = "Open System Settings with an on-screen guide for granting the missing permissions (macOS)"
    )]
    #[serde(default)]
    pub guide: bool,
}

#[cfg(test)]
#[path = "system_tests.rs"]
mod tests;
