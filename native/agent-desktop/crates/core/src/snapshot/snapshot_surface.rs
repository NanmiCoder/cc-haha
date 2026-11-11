#[non_exhaustive]
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotSurface {
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
    #[serde(alias = "system-tray")]
    SystemTray,
    #[serde(alias = "quick-settings")]
    QuickSettings,
    #[serde(alias = "notification-center")]
    NotificationCenter,
    Toolbar,
    Dock,
    Spotlight,
    #[serde(alias = "menu-bar-extras")]
    MenuBarExtras,
    #[serde(alias = "system-tray-overflow")]
    SystemTrayOverflow,
    #[serde(alias = "start-menu")]
    StartMenu,
    #[serde(alias = "action-center")]
    ActionCenter,
}

impl SnapshotSurface {
    pub fn is_window(surface: &Self) -> bool {
        matches!(surface, Self::Window)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Focused => "focused",
            Self::Menu => "menu",
            Self::Menubar => "menubar",
            Self::Sheet => "sheet",
            Self::Popover => "popover",
            Self::Alert => "alert",
            Self::Desktop => "desktop",
            Self::Taskbar => "taskbar",
            Self::SystemTray => "system-tray",
            Self::QuickSettings => "quick-settings",
            Self::NotificationCenter => "notification-center",
            Self::Toolbar => "toolbar",
            Self::Dock => "dock",
            Self::Spotlight => "spotlight",
            Self::MenuBarExtras => "menu-bar-extras",
            Self::SystemTrayOverflow => "system-tray-overflow",
            Self::StartMenu => "start-menu",
            Self::ActionCenter => "action-center",
        }
    }
}
