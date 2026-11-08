use clap::Subcommand;

mod identity;
mod post_action_wait;
mod root;

pub(crate) use root::Cli;

use crate::cli_args::{
    FindArgs, GetArgs, IsArgs, ListSurfacesArgs, RefArgs, ScreenshotArgs, SnapshotArgs,
    actions::{
        HoverArgs, KeyComboArgs, MouseClickArgs, MouseMoveArgs, MousePointArgs, PressArgs,
        ScrollArgs, SelectArgs, SetValueArgs, TypeArgs,
    },
    batch::BatchArgs,
    cursor_overlay::CursorOverlayArgs,
    drag::DragCliArgs,
    mouse_wheel::MouseWheelArgs,
    notifications::{
        DismissAllNotificationsCliArgs, DismissNotificationCliArgs, ListNotificationsCliArgs,
        NotificationActionCliArgs,
    },
    session::SessionArgs,
    skills::SkillsArgs,
    system::{
        AppRefArgs, ClipboardGetArgs, ClipboardSetArgs, CloseAppArgs, FocusWindowArgs, LaunchArgs,
        ListAppsArgs, ListWindowsArgs, MoveWindowCliArgs, OpenSystemSurfaceArgs, PermissionsArgs,
        ResizeWindowCliArgs, StatusArgs, WaitArgs,
    },
    trace::TraceArgs,
};

#[derive(Subcommand, Debug)]
pub(crate) enum Commands {
    #[command(about = "Capture accessibility tree as structured JSON with @ref IDs")]
    Snapshot(SnapshotArgs),
    #[command(about = "Search elements by role, name, value, or text content")]
    Find(FindArgs),
    #[command(about = "Take a PNG screenshot of an application window")]
    Screenshot(ScreenshotArgs),
    #[command(about = "Read an element property (text, value, title, bounds, role, states)")]
    Get(GetArgs),
    #[command(
        about = "Check element state (visible, enabled, checked, focused, expanded, selected)"
    )]
    Is(IsArgs),
    #[command(about = "Click element via accessibility press action")]
    Click(RefArgs),
    #[command(about = "Physically double-click element; requires --headed")]
    DoubleClick(RefArgs),
    #[command(
        about = "Triple-click element; returns POLICY_DENIED when physical input is disabled"
    )]
    TripleClick(RefArgs),
    #[command(about = "Open a context menu semantically, or physically with --headed")]
    RightClick(RefArgs),
    #[command(about = "Insert text into a text target")]
    Type(TypeArgs),
    #[command(about = "Set element value directly via accessibility attribute")]
    SetValue(SetValueArgs),
    #[command(about = "Clear element value to empty string")]
    Clear(RefArgs),
    #[command(about = "Set keyboard focus on element")]
    Focus(RefArgs),
    #[command(about = "Select an option in a list or dropdown")]
    Select(SelectArgs),
    #[command(about = "Toggle a checkbox or switch")]
    Toggle(RefArgs),
    #[command(about = "Set checkbox or switch to checked state (idempotent)")]
    Check(RefArgs),
    #[command(about = "Set checkbox or switch to unchecked state (idempotent)")]
    Uncheck(RefArgs),
    #[command(about = "Expand a disclosure triangle or tree item")]
    Expand(RefArgs),
    #[command(about = "Collapse a disclosure triangle or tree item")]
    Collapse(RefArgs),
    #[command(about = "Scroll element (--direction up/down/left/right, --amount N)")]
    Scroll(ScrollArgs),
    #[command(about = "Scroll element into visible area")]
    ScrollTo(RefArgs),
    #[command(about = "Send a key combo: return, escape, cmd+c, shift+tab ...")]
    Press(PressArgs),
    #[command(about = "Hold a key or modifier down")]
    KeyDown(KeyComboArgs),
    #[command(about = "Release a held key or modifier")]
    KeyUp(KeyComboArgs),
    #[command(about = "Move cursor to element center or coordinates (requires --headed)")]
    Hover(HoverArgs),
    #[command(about = "Drag from one element or point to another (requires --headed)")]
    Drag(DragCliArgs),
    #[command(about = "Move cursor to absolute screen coordinates (requires --headed)")]
    MouseMove(MouseMoveArgs),
    #[command(about = "Click at absolute screen coordinates (requires --headed)")]
    MouseClick(MouseClickArgs),
    #[command(
        about = "Press mouse button at coordinates (fails closed in stateless mode; use mouse-click or drag)"
    )]
    MouseDown(MousePointArgs),
    #[command(
        about = "Release mouse button at coordinates (fails closed in stateless mode; use mouse-click or drag)"
    )]
    MouseUp(MousePointArgs),
    #[command(about = "Scroll the mouse wheel at absolute coordinates (requires --headed)")]
    MouseWheel(MouseWheelArgs),
    #[command(
        about = "Launch application and return once its process is running; --activate waits for a window, --cdp verifies a DevTools endpoint"
    )]
    Launch(LaunchArgs),
    #[command(about = "Quit an application gracefully (--force to terminate)")]
    CloseApp(CloseAppArgs),
    #[command(about = "List all visible windows (--app to filter by application)")]
    ListWindows(ListWindowsArgs),
    #[command(about = "List connected displays with bounds and scale factor")]
    ListDisplays,
    #[command(about = "List all running GUI applications (--app to filter)")]
    ListApps(ListAppsArgs),
    #[command(about = "Bring a window to front and confirm OS focus")]
    FocusWindow(FocusWindowArgs),
    #[command(about = "Resize application window")]
    ResizeWindow(ResizeWindowCliArgs),
    #[command(about = "Move application window to new position")]
    MoveWindow(MoveWindowCliArgs),
    #[command(about = "Minimize application window")]
    Minimize(AppRefArgs),
    #[command(about = "Maximize or zoom application window")]
    Maximize(AppRefArgs),
    #[command(about = "Restore minimized or maximized window")]
    Restore(AppRefArgs),
    #[command(about = "List accessibility surfaces for an app (window, menu, sheet ...)")]
    ListSurfaces(ListSurfacesArgs),
    #[command(
        about = "Open a shell surface (start-menu, taskbar, action-center ...) and return the window it presents"
    )]
    OpenSystemSurface(OpenSystemSurfaceArgs),
    #[command(about = "List notifications from Notification Center")]
    ListNotifications(ListNotificationsCliArgs),
    #[command(about = "Dismiss a notification by index")]
    DismissNotification(DismissNotificationCliArgs),
    #[command(about = "Dismiss all notifications (--app to filter)")]
    DismissAllNotifications(DismissAllNotificationsCliArgs),
    #[command(about = "Click an action button on a notification")]
    NotificationAction(NotificationActionCliArgs),
    #[command(about = "Read plain-text or typed clipboard contents")]
    ClipboardGet(ClipboardGetArgs),
    #[command(about = "Write text to the clipboard")]
    ClipboardSet(ClipboardSetArgs),
    #[command(about = "Clear the clipboard")]
    ClipboardClear,
    #[command(about = "Wait for time (ms), element presence, text, or window appearance")]
    Wait(WaitArgs),
    #[command(about = "Show adapter health, platform info, and permission state")]
    Status(StatusArgs),
    #[command(
        about = "Check nested permission states: accessibility/screen_recording/automation each return {state,...}"
    )]
    Permissions(PermissionsArgs),
    #[command(about = "Show version, target architecture, and OS")]
    Version,
    #[command(about = "Execute a bounded, sequential, non-atomic JSON command batch")]
    Batch(BatchArgs),
    #[command(about = "Bundled skill docs for AI agents (list, get, path)")]
    Skills(SkillsArgs),
    #[command(about = "Manage trace-enabled agent sessions (start, end, list, gc)")]
    Session(SessionArgs),
    #[command(about = "Configure the presentation-only cursor overlay for a session")]
    CursorOverlay(CursorOverlayArgs),
    #[command(about = "Read merged session trace timelines")]
    Trace(TraceArgs),
}

#[derive(Clone, Copy)]
struct CommandMetadata {
    name: &'static str,
    post_action_wait: bool,
}

impl CommandMetadata {
    const fn new(name: &'static str, post_action_wait: bool) -> Self {
        Self {
            name,
            post_action_wait,
        }
    }
}

impl Commands {
    fn metadata(&self) -> CommandMetadata {
        match self {
            Self::Snapshot(_) => CommandMetadata::new("snapshot", true),
            Self::Find(_) => CommandMetadata::new("find", false),
            Self::Screenshot(_) => CommandMetadata::new("screenshot", false),
            Self::Get(_) => CommandMetadata::new("get", false),
            Self::Is(_) => CommandMetadata::new("is", false),
            Self::Click(_) => CommandMetadata::new("click", true),
            Self::DoubleClick(_) => CommandMetadata::new("double-click", true),
            Self::TripleClick(_) => CommandMetadata::new("triple-click", true),
            Self::RightClick(_) => CommandMetadata::new("right-click", true),
            Self::Type(_) => CommandMetadata::new("type", true),
            Self::SetValue(_) => CommandMetadata::new("set-value", true),
            Self::Clear(_) => CommandMetadata::new("clear", true),
            Self::Focus(_) => CommandMetadata::new("focus", true),
            Self::Select(_) => CommandMetadata::new("select", true),
            Self::Toggle(_) => CommandMetadata::new("toggle", true),
            Self::Check(_) => CommandMetadata::new("check", true),
            Self::Uncheck(_) => CommandMetadata::new("uncheck", true),
            Self::Expand(_) => CommandMetadata::new("expand", true),
            Self::Collapse(_) => CommandMetadata::new("collapse", true),
            Self::Scroll(_) => CommandMetadata::new("scroll", true),
            Self::ScrollTo(_) => CommandMetadata::new("scroll-to", true),
            Self::Press(_) => CommandMetadata::new("press", true),
            Self::KeyDown(_) => CommandMetadata::new("key-down", false),
            Self::KeyUp(_) => CommandMetadata::new("key-up", false),
            Self::Hover(_) => CommandMetadata::new("hover", true),
            Self::Drag(_) => CommandMetadata::new("drag", true),
            Self::MouseMove(_) => CommandMetadata::new("mouse-move", false),
            Self::MouseClick(_) => CommandMetadata::new("mouse-click", false),
            Self::MouseDown(_) => CommandMetadata::new("mouse-down", false),
            Self::MouseUp(_) => CommandMetadata::new("mouse-up", false),
            Self::MouseWheel(_) => CommandMetadata::new("mouse-wheel", false),
            Self::Launch(_) => CommandMetadata::new("launch", false),
            Self::CloseApp(_) => CommandMetadata::new("close-app", false),
            Self::ListWindows(_) => CommandMetadata::new("list-windows", false),
            Self::ListDisplays => CommandMetadata::new("list-displays", false),
            Self::ListApps(_) => CommandMetadata::new("list-apps", false),
            Self::FocusWindow(_) => CommandMetadata::new("focus-window", false),
            Self::ResizeWindow(_) => CommandMetadata::new("resize-window", false),
            Self::MoveWindow(_) => CommandMetadata::new("move-window", false),
            Self::Minimize(_) => CommandMetadata::new("minimize", false),
            Self::Maximize(_) => CommandMetadata::new("maximize", false),
            Self::Restore(_) => CommandMetadata::new("restore", false),
            Self::ListSurfaces(_) => CommandMetadata::new("list-surfaces", false),
            Self::OpenSystemSurface(_) => CommandMetadata::new("open-system-surface", false),
            Self::ListNotifications(_) => CommandMetadata::new("list-notifications", false),
            Self::DismissNotification(_) => CommandMetadata::new("dismiss-notification", false),
            Self::DismissAllNotifications(_) => {
                CommandMetadata::new("dismiss-all-notifications", false)
            }
            Self::NotificationAction(_) => CommandMetadata::new("notification-action", false),
            Self::ClipboardGet(_) => CommandMetadata::new("clipboard-get", false),
            Self::ClipboardSet(_) => CommandMetadata::new("clipboard-set", false),
            Self::ClipboardClear => CommandMetadata::new("clipboard-clear", false),
            Self::Wait(_) => CommandMetadata::new("wait", false),
            Self::Status(_) => CommandMetadata::new("status", false),
            Self::Permissions(_) => CommandMetadata::new("permissions", false),
            Self::Version => CommandMetadata::new("version", false),
            Self::Batch(_) => CommandMetadata::new("batch", false),
            Self::Skills(_) => CommandMetadata::new("skills", false),
            Self::Session(_) => CommandMetadata::new("session", false),
            Self::CursorOverlay(_) => CommandMetadata::new("cursor-overlay", false),
            Self::Trace(_) => CommandMetadata::new("trace", false),
        }
    }

    pub(crate) fn name(&self) -> &'static str {
        self.metadata().name
    }

    pub(crate) fn supports_post_action_wait(&self) -> bool {
        self.metadata().post_action_wait
    }

    #[cfg(target_os = "macos")]
    /// Permission guidance needs the caller; session management crosses host namespaces.
    pub(crate) fn needs_caller_process(&self) -> bool {
        matches!(self, Self::Session(_) | Self::Batch(_))
            || matches!(self, Self::Permissions(args) if args.guide)
    }

    pub(crate) fn is_mutating(&self) -> bool {
        match self {
            Self::Click(_)
            | Self::DoubleClick(_)
            | Self::TripleClick(_)
            | Self::RightClick(_)
            | Self::Type(_)
            | Self::SetValue(_)
            | Self::Clear(_)
            | Self::Focus(_)
            | Self::Select(_)
            | Self::Toggle(_)
            | Self::Check(_)
            | Self::Uncheck(_)
            | Self::Expand(_)
            | Self::Collapse(_)
            | Self::Scroll(_)
            | Self::ScrollTo(_)
            | Self::Press(_)
            | Self::KeyDown(_)
            | Self::KeyUp(_)
            | Self::Hover(_)
            | Self::Drag(_)
            | Self::MouseMove(_)
            | Self::MouseClick(_)
            | Self::MouseDown(_)
            | Self::MouseUp(_)
            | Self::MouseWheel(_)
            | Self::Launch(_)
            | Self::CloseApp(_)
            | Self::FocusWindow(_)
            | Self::OpenSystemSurface(_)
            | Self::ResizeWindow(_)
            | Self::MoveWindow(_)
            | Self::Minimize(_)
            | Self::Maximize(_)
            | Self::Restore(_)
            | Self::DismissNotification(_)
            | Self::DismissAllNotifications(_)
            | Self::NotificationAction(_)
            | Self::ClipboardSet(_)
            | Self::ClipboardClear
            | Self::Batch(_) => true,
            Self::Screenshot(args) => args.output_path.is_some(),
            Self::ClipboardGet(args) => args.out.is_some(),
            Self::Permissions(args) => args.request,
            Self::Session(args) => {
                !matches!(&args.action, crate::cli_args::session::SessionAction::List)
            }
            Self::CursorOverlay(_) => true,
            Self::Trace(args) => {
                matches!(&args.action, crate::cli_args::trace::TraceAction::Export(_))
            }
            Self::Snapshot(_)
            | Self::Find(_)
            | Self::Get(_)
            | Self::Is(_)
            | Self::ListWindows(_)
            | Self::ListDisplays
            | Self::ListApps(_)
            | Self::ListSurfaces(_)
            | Self::ListNotifications(_)
            | Self::Wait(_)
            | Self::Status(_)
            | Self::Version
            | Self::Skills(_) => false,
        }
    }
}

#[cfg(test)]
#[path = "wait_for_cli_tests.rs"]
mod wait_for_cli_tests;

#[cfg(test)]
#[path = "contract_tests.rs"]
mod contract_tests;

#[cfg(test)]
#[path = "contract_command_surface_tests.rs"]
mod contract_command_surface_tests;

#[cfg(test)]
mod agent_identity_tests;

#[cfg(test)]
mod product_bridge_tests;
