use clap::{Args, Parser, ValueEnum};
use serde::Deserialize;

pub(crate) mod actions;
pub(crate) mod batch;
pub(crate) mod cursor_overlay;
pub(crate) mod cursor_overlay_action;
pub(crate) mod cursor_overlay_enable;
pub(crate) mod cursor_overlay_images;
pub(crate) mod cursor_overlay_motion;
pub(crate) mod cursor_overlay_style;
pub(crate) mod drag;
pub(crate) mod drag_target;
pub(crate) mod interaction;
pub(crate) mod mouse_wheel;
pub(crate) mod notifications;
pub(crate) mod session;
pub(crate) mod skills;
mod snapshot;
pub(crate) mod snapshot_tree;
pub(crate) mod system;
pub(crate) mod trace;

pub(crate) use snapshot::SnapshotArgs;

fn default_get_property() -> String {
    "text".to_string()
}

fn default_is_property() -> String {
    "visible".to_string()
}

#[derive(ValueEnum, Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Surface {
    #[default]
    Window,
    Focused,
    Menu,
    Menubar,
    Sheet,
    Popover,
    Alert,
    Desktop,
    Taskbar,
    #[value(alias = "system_tray")]
    #[serde(alias = "system_tray")]
    SystemTray,
    #[value(alias = "quick_settings")]
    #[serde(alias = "quick_settings")]
    QuickSettings,
    #[value(alias = "notification_center")]
    #[serde(alias = "notification_center")]
    NotificationCenter,
    Toolbar,
    Dock,
    Spotlight,
    #[value(alias = "menu_bar_extras")]
    #[serde(alias = "menu_bar_extras")]
    MenuBarExtras,
    #[value(alias = "system_tray_overflow")]
    #[serde(alias = "system_tray_overflow")]
    SystemTrayOverflow,
    #[value(alias = "start_menu")]
    #[serde(alias = "start_menu")]
    StartMenu,
    #[value(alias = "action_center")]
    #[serde(alias = "action_center")]
    ActionCenter,
}

impl Surface {
    pub(crate) fn to_core(&self) -> agent_desktop_core::SnapshotSurface {
        use agent_desktop_core::SnapshotSurface;
        match self {
            Self::Window => SnapshotSurface::Window,
            Self::Focused => SnapshotSurface::Focused,
            Self::Menu => SnapshotSurface::Menu,
            Self::Menubar => SnapshotSurface::Menubar,
            Self::Sheet => SnapshotSurface::Sheet,
            Self::Popover => SnapshotSurface::Popover,
            Self::Alert => SnapshotSurface::Alert,
            Self::Desktop => SnapshotSurface::Desktop,
            Self::Taskbar => SnapshotSurface::Taskbar,
            Self::SystemTray => SnapshotSurface::SystemTray,
            Self::QuickSettings => SnapshotSurface::QuickSettings,
            Self::NotificationCenter => SnapshotSurface::NotificationCenter,
            Self::Toolbar => SnapshotSurface::Toolbar,
            Self::Dock => SnapshotSurface::Dock,
            Self::Spotlight => SnapshotSurface::Spotlight,
            Self::MenuBarExtras => SnapshotSurface::MenuBarExtras,
            Self::SystemTrayOverflow => SnapshotSurface::SystemTrayOverflow,
            Self::StartMenu => SnapshotSurface::StartMenu,
            Self::ActionCenter => SnapshotSurface::ActionCenter,
        }
    }
}

/// Window-targeting scope shared by the read/capture commands that choose which
/// window to operate on (`snapshot`, `find`, `screenshot`). Ref-based commands
/// (`click`/`type`/`get`/`is`) deliberately omit it — a ref already carries its
/// source window through its `RefEntry` — and keyboard input targets the focused
/// window, so neither needs an explicit window selector.
#[derive(Args, Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct WindowScope {
    #[arg(long, help = "Filter to application by name")]
    #[serde(default)]
    pub app: Option<String>,
    #[arg(
        long,
        name = "window-id",
        help = "Scope to a single window ID (from list-windows)"
    )]
    #[serde(default)]
    pub window_id: Option<String>,
}

/// Match-criteria fields, grouped out of [`FindArgs`] to keep it under the
/// repo's field-count limit. Mirrors `core::commands::find::FindFilterArgs`.
#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FindFilterArgs {
    #[arg(
        long,
        help = "Match by accessibility role (button, textfield, checkbox ...)"
    )]
    pub role: Option<String>,
    #[arg(long, help = "Match by accessible name or label")]
    pub name: Option<String>,
    #[arg(long, help = "Match by current value")]
    pub value: Option<String>,
    #[arg(long, help = "Match by text in name, value, title, or description")]
    pub text: Option<String>,
    #[arg(long, help = "Match by accessible description")]
    pub description: Option<String>,
    #[arg(long, help = "Match by native automation id (AXIdentifier)")]
    pub native_id: Option<String>,
    #[arg(
        long,
        help = "Require exact (case-insensitive) name/description/value matches"
    )]
    #[serde(default)]
    pub exact: bool,
}

/// Result-shaping fields, grouped out of [`FindArgs`] to keep it under the
/// repo's field-count limit. Mutually exclusive at the CLI layer (enforced
/// via `conflicts_with_all` on each field, unaffected by the grouping since
/// clap arg ids stay global across `#[command(flatten)]` boundaries).
#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FindSelectionArgs {
    #[arg(
        long,
        help = "Return match count only",
        conflicts_with_all = ["first", "last", "nth", "limit"]
    )]
    #[serde(default)]
    pub count: bool,
    #[arg(
        long,
        help = "Return first match only",
        conflicts_with_all = ["count", "last", "nth", "limit"]
    )]
    #[serde(default)]
    pub first: bool,
    #[arg(
        long,
        help = "Return last match only",
        conflicts_with_all = ["count", "first", "nth", "limit"]
    )]
    #[serde(default)]
    pub last: bool,
    #[arg(
        long,
        help = "Return Nth match (0-indexed)",
        conflicts_with_all = ["count", "first", "last", "limit"]
    )]
    pub nth: Option<usize>,
    #[arg(
        long,
        help = "Return at most N matches; defaults to 50 when omitted, use 0 for all",
        conflicts_with_all = ["count", "first", "last", "nth"]
    )]
    pub limit: Option<usize>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FindArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[command(flatten)]
    #[serde(flatten)]
    pub filter: FindFilterArgs,
    #[arg(
        long,
        help = "Search only inside this ref's subtree, not the whole window"
    )]
    pub root: Option<String>,
    #[arg(
        long,
        value_enum,
        default_value_t = Surface::Window,
        help = "Surface to search (menubar, menu, sheet ...) instead of the window"
    )]
    #[serde(default)]
    pub surface: Surface,
    #[arg(
        long = "state",
        value_name = "TOKEN[=BOOL]",
        help = "Filter by state token (repeatable); append =true or =false"
    )]
    #[serde(default)]
    pub states: Vec<String>,
    #[arg(
        long = "timeout-ms",
        value_name = "MS",
        help = "Traversal deadline in milliseconds (default 5000; raise for a large tree such as a shell file dialog)"
    )]
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[command(flatten)]
    #[serde(flatten)]
    pub selection: FindSelectionArgs,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScreenshotArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[arg(
        long,
        help = "Capture display by index (from list-displays; 0 = primary)"
    )]
    pub screen: Option<usize>,
    #[arg(value_name = "PATH", help = "Save to file instead of returning base64")]
    pub output_path: Option<std::path::PathBuf>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GetArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(
        long,
        default_value = "text",
        help = "Property: text (what a person reads: content for text-bearing roles, otherwise the name), value, title, bounds, role, states"
    )]
    #[serde(default = "default_get_property")]
    pub property: String,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IsArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(
        long,
        default_value = "visible",
        help = "State: visible, enabled, checked, focused, expanded, selected"
    )]
    #[serde(default = "default_is_property")]
    pub property: String,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RefArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_ref_timeout_ms() -> u64 {
    5000
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListSurfacesArgs {
    #[arg(long, help = "Filter to application by name")]
    pub app: Option<String>,
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod mod_tests;
