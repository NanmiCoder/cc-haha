use agent_desktop_core::SnapshotSurface;

#[cfg(target_os = "windows")]
const _: () = {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as win32;
    assert!(VK_A == 0x41);
    assert!(VK_LWIN == win32::VK_LWIN);
    assert!(VK_ESCAPE == win32::VK_ESCAPE);
};

/// The window class every immersive shell surface presents on this build.
/// Matching keys on the class plus the hosting shell process, never on the
/// element's name: the name is localized on this host (A26-1 measured the
/// Action Center as a class-`Windows.UI.Core.CoreWindow` child of the UIA
/// root hosted by `shell_experience_host`).
pub(in crate::system) const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

const SHELL_TRAY_WND_CLASS: &str = "Shell_TrayWnd";
const TRAY_NOTIFY_CLASS: &str = "TrayNotifyWnd";
const TOOLBAR_CLASS: &str = "ToolbarWindow32";
/// The notification area's toolbar is nested one level below
/// `TrayNotifyWnd` rather than being its direct child. The direct child of
/// that class is a zero-extent sibling whose automation element carries no
/// children, so a chain that stops one hop short resolves a window that
/// reads empty. Measured parent chains: the collapsed sibling is
/// `ToolbarWindow32 <- TrayNotifyWnd`, the promoted area is
/// `ToolbarWindow32 <- SysPager <- TrayNotifyWnd`.
const SYS_PAGER_CLASS: &str = "SysPager";
const OVERFLOW_WINDOW_CLASS: &str = "NotifyIconOverflowWindow";

pub(crate) const VK_A: u16 = 0x41;
pub(crate) const VK_LWIN: u16 = 0x5B;
pub(crate) const VK_ESCAPE: u16 = 0x1B;

const ACTION_CENTER_HOSTS: &[&str] = &["shellexperiencehost"];
const START_HOSTS: &[&str] = &[
    "shellexperiencehost",
    "searchui",
    "searchhost",
    "searchapp",
    "startmenuexperiencehost",
];

/// The notification list's landmark `AutomationId` (A26-3), the root the
/// notification reader walks. A center carrying at least one notification
/// presents it; the empty-center state swaps it for [`EMPTY_CENTER_LANDMARKS`].
pub(crate) const MAIN_LIST_VIEW: &str = "MainListView";

/// The landmarks the empty-center state presents in place of
/// [`MAIN_LIST_VIEW`] (A26-3): an open center carrying either is legitimately
/// empty, not a tree this adapter fails to recognize.
pub(crate) const EMPTY_CENTER_LANDMARKS: &[&str] = &["NoNotificationsTextBlock", "ScrollWrapper"];

/// The Action Center's measured landmark `AutomationId`s, read on this build
/// in both of its content states: `MainListView` when notifications are
/// present (A26-3), and the empty-center shape's `NoNotificationsTextBlock`
/// and `ScrollWrapper` when none are. One landmark list covers both states so
/// an empty center still resolves to itself rather than to another
/// `ShellExperienceHost`-hosted surface.
const ACTION_CENTER_LANDMARKS: &[&str] = &[
    MAIN_LIST_VIEW,
    EMPTY_CENTER_LANDMARKS[0],
    EMPTY_CENTER_LANDMARKS[1],
];

/// The search surface's measured landmark: the Start accelerator's overlay
/// carries `SearchTextBox` at its root (A26-9), which is also what keeps this
/// kind from resolving the Action Center's CoreWindow - on this build both are
/// hosted by the same `ShellExperienceHost` process, so the host image alone
/// cannot tell them apart and only the landmark can.
const START_LANDMARKS: &[&str] = &["SearchTextBox"];

/// One row of the kind table: what the surface roots at, how it is reached,
/// how it is raised and dismissed, and whether this build exposes it at all.
pub(crate) struct SurfaceKindRow {
    pub(crate) kind: SnapshotSurface,
    pub(crate) family: SurfaceFamily,
    pub(crate) raise: SurfaceRaise,
    pub(crate) dismiss: SurfaceDismiss,
    pub(crate) exists_on_build: bool,
    pub(crate) capability_holder: Option<&'static str>,
}

/// The two reach families, chosen per surface because the families are
/// unreachable for different measured reasons: the `Shell_TrayWnd` family is
/// yielded by `EnumWindows` but rejected by the shipped agent-window filter on
/// its tool bit, while the immersive family never appears in that walk at all
/// and is reached only through the UIA root's children (A26-1).
///
/// The chain names the exact windows a kind roots at, top-level first. The
/// three tray-family kinds root at three different windows - the taskbar at
/// `Shell_TrayWnd`, the notification area at the toolbar promoted inside
/// `TrayNotifyWnd`, the overflow at the hidden overflow window's own toolbar -
/// so no two advertised kinds can return the same identity (A26-5, A26-6).
#[derive(Clone, Copy)]
pub(crate) enum SurfaceFamily {
    Win32Class(&'static [&'static str]),
    Immersive {
        expected_class: &'static str,
        host_images: &'static [&'static str],
        landmarks: &'static [&'static str],
    },
}

/// The three raise mechanisms measurement found: two surfaces are already up,
/// two come up on a shell accelerator, and the overflow is raised by invoking
/// a control rather than by any key the shell listens for.
#[derive(Clone, Copy)]
pub(crate) enum SurfaceRaise {
    AlreadyRaised,
    Accelerator { modifiers: &'static [u16], key: u16 },
    ChevronInvoke,
}

/// The dismiss half of [`SurfaceRaise`]: the Action Center closes on its
/// Win+A toggle, and the Start overlay closes on Esc - measured, because on
/// this build the Meta toggle re-raises it rather than dismissing it. The
/// always-up tray family has nothing to dismiss.
///
/// [`SurfaceDismiss::RaiseThenEscape`] is Escape with the precondition Escape
/// silently depends on. A synthesized Escape goes to whichever window owns the
/// foreground, so it dismisses a surface only while that surface owns it.
/// Measured on the overflow: Escape sent while another window held the
/// foreground left the flyout up past every poll and went into that window
/// instead, and an Escape sent after the shell's own chevron raise dismissed
/// it inside one 100ms poll. Re-running the raise first covers both states the
/// flyout can be in - it toggles a properly presented flyout closed outright,
/// and it activates one that is visible without activation so the Escape that
/// follows reaches it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SurfaceDismiss {
    None,
    Escape,
    RaiseThenEscape,
    Toggle,
}

/// The kind table behind open-system-surface. `start-menu` resolves to
/// whatever surface the Meta accelerator actually raises, which on this build
/// is a full-screen search-hosted overlay carrying `SearchTextBox` (A26-9)
/// rather than a tile surface - that is the identity of the window the surface
/// actually presents, which is what the contract asks for. The same session's
/// measurement showed the overlay's foreground goes to the search input's own
/// window inside it, so the rootable identity is the overlay, not the
/// foreground read. `quick-settings` is a build-conditional refusal row: on
/// this build the quick actions are a pane inside the Action Center, so the
/// refusal names `action-center` as the surface carrying the capability.
///
/// The immersive rows gate their candidates on the hosting shell process
/// image (A26-1: `shellexperiencehost` for the Action Center) AND a landmark
/// `AutomationId` in the surface's subtree, because on this build both
/// immersive kinds are hosted by the same shell host process and only the
/// landmark tells them apart. The Start overlay dismisses on Esc, not on the
/// Meta toggle (A26-9's Esc restore; the toggle re-raises rather than
/// dismisses), so its dismiss mechanism is Escape.
const KINDS: &[SurfaceKindRow] = &[
    SurfaceKindRow {
        kind: SnapshotSurface::Taskbar,
        family: SurfaceFamily::Win32Class(&[SHELL_TRAY_WND_CLASS]),
        raise: SurfaceRaise::AlreadyRaised,
        dismiss: SurfaceDismiss::None,
        exists_on_build: true,
        capability_holder: None,
    },
    SurfaceKindRow {
        kind: SnapshotSurface::SystemTray,
        family: SurfaceFamily::Win32Class(&[
            SHELL_TRAY_WND_CLASS,
            TRAY_NOTIFY_CLASS,
            SYS_PAGER_CLASS,
            TOOLBAR_CLASS,
        ]),
        raise: SurfaceRaise::AlreadyRaised,
        dismiss: SurfaceDismiss::None,
        exists_on_build: true,
        capability_holder: None,
    },
    SurfaceKindRow {
        kind: SnapshotSurface::SystemTrayOverflow,
        family: SurfaceFamily::Win32Class(&[OVERFLOW_WINDOW_CLASS, TOOLBAR_CLASS]),
        raise: SurfaceRaise::ChevronInvoke,
        dismiss: SurfaceDismiss::RaiseThenEscape,
        exists_on_build: true,
        capability_holder: None,
    },
    SurfaceKindRow {
        kind: SnapshotSurface::StartMenu,
        family: SurfaceFamily::Immersive {
            expected_class: CORE_WINDOW_CLASS,
            host_images: START_HOSTS,
            landmarks: START_LANDMARKS,
        },
        raise: SurfaceRaise::Accelerator {
            modifiers: &[],
            key: VK_LWIN,
        },
        dismiss: SurfaceDismiss::Escape,
        exists_on_build: true,
        capability_holder: None,
    },
    SurfaceKindRow {
        kind: SnapshotSurface::ActionCenter,
        family: SurfaceFamily::Immersive {
            expected_class: CORE_WINDOW_CLASS,
            host_images: ACTION_CENTER_HOSTS,
            landmarks: ACTION_CENTER_LANDMARKS,
        },
        raise: SurfaceRaise::Accelerator {
            modifiers: &[VK_LWIN],
            key: VK_A,
        },
        dismiss: SurfaceDismiss::Toggle,
        exists_on_build: true,
        capability_holder: None,
    },
    SurfaceKindRow {
        kind: SnapshotSurface::QuickSettings,
        family: SurfaceFamily::Immersive {
            expected_class: CORE_WINDOW_CLASS,
            host_images: &[],
            landmarks: &[],
        },
        raise: SurfaceRaise::AlreadyRaised,
        dismiss: SurfaceDismiss::None,
        exists_on_build: false,
        capability_holder: Some("action-center"),
    },
];

pub(crate) fn row_for(kind: SnapshotSurface) -> Option<&'static SurfaceKindRow> {
    KINDS.iter().find(|row| row.kind == kind)
}

#[cfg(all(test, target_os = "windows"))]
#[path = "shell_surface_kinds_tests.rs"]
mod tests;
