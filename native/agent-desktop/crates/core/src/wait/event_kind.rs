use crate::snapshot::snapshot_surface::SnapshotSurface;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    WindowOpened,
    WindowClosed,
    AppLaunched,
    AppTerminated,
    FocusChangedWindow,
    SurfaceAppeared { surface: SnapshotSurface },
    SurfaceDismissed { surface: SnapshotSurface },
}

impl EventKind {
    pub fn same_variant(&self, other: &EventKind) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }

    pub fn cli_token(&self) -> &'static str {
        match self {
            EventKind::WindowOpened => "window-opened",
            EventKind::WindowClosed => "window-closed",
            EventKind::AppLaunched => "app-launched",
            EventKind::AppTerminated => "app-terminated",
            EventKind::FocusChangedWindow => "focus-changed",
            EventKind::SurfaceAppeared { .. } => "surface-appeared",
            EventKind::SurfaceDismissed { .. } => "surface-dismissed",
        }
    }

    pub fn all_tokens() -> &'static [&'static str] {
        &[
            "window-opened",
            "window-closed",
            "app-launched",
            "app-terminated",
            "focus-changed",
            "surface-appeared",
            "surface-dismissed",
        ]
    }

    pub fn parse(token: &str) -> Option<EventKind> {
        match token {
            "window-opened" => Some(EventKind::WindowOpened),
            "window-closed" => Some(EventKind::WindowClosed),
            "app-launched" => Some(EventKind::AppLaunched),
            "app-terminated" => Some(EventKind::AppTerminated),
            "focus-changed" => Some(EventKind::FocusChangedWindow),
            "surface-appeared" => Some(EventKind::SurfaceAppeared {
                surface: SnapshotSurface::Window,
            }),
            "surface-dismissed" => Some(EventKind::SurfaceDismissed {
                surface: SnapshotSurface::Window,
            }),
            _ => None,
        }
    }
}
