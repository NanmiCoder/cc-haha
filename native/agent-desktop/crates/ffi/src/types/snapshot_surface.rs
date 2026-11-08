#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdSnapshotSurface {
    Window = 0,
    Focused = 1,
    Menu = 2,
    Menubar = 3,
    Sheet = 4,
    Popover = 5,
    Alert = 6,
    Desktop = 7,
    Taskbar = 8,
    SystemTray = 9,
    QuickSettings = 10,
    NotificationCenter = 11,
    Toolbar = 12,
    Dock = 13,
    Spotlight = 14,
    MenuBarExtras = 15,
    SystemTrayOverflow = 16,
    StartMenu = 17,
    ActionCenter = 18,
}
