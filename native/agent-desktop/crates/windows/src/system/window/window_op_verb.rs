#[derive(Clone, Copy)]
pub(crate) enum ShowVerb {
    Minimize,
    Maximize,
    Restore,
}

/// Whether the placement the window reports satisfies the verb that was asked.
///
/// Restore is "no longer minimized" rather than an exact normal placement: a
/// window minimized while maximized carries `WPF_RESTORETOMAXIMIZED`, so
/// `SW_RESTORE` correctly returns it to maximized and demanding
/// `SW_SHOWNORMAL` would call that ordinary sequence a failure. The product
/// verb undoes the minimize; it does not promise to un-maximize.
#[cfg(target_os = "windows")]
pub(crate) fn verb_is_satisfied(verb: ShowVerb, show_cmd: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED};

    match verb {
        ShowVerb::Minimize => show_cmd == SW_SHOWMINIMIZED as u32,
        ShowVerb::Maximize => show_cmd == SW_SHOWMAXIMIZED as u32,
        ShowVerb::Restore => show_cmd != SW_SHOWMINIMIZED as u32,
    }
}
