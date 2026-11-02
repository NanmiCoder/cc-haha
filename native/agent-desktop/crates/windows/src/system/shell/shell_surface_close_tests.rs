//! The close path's delivery precondition, driven against the live shell: a
//! surface that is presented but owns no foreground is exactly the state a
//! keystroke-only dismissal cannot leave, and it is self-perpetuating - every
//! later close of that surface fails the same way until something outside the
//! product clears it.

use agent_desktop_core::{InteractionPolicy, SnapshotSurface};

use crate::system::fixture::test_support::{SHELL_SURFACE_LOCK, settles_to};
use crate::system::shell::shell_surface_open::{close_surface, open_surface};

use crate::system::fixture::test_time::deadline;

fn overflow_top() -> Option<*mut core::ffi::c_void> {
    crate::system::shell::shell_surface::class_chain_top_handle(&["NotifyIconOverflowWindow"])
}

fn visible(top: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;

    unsafe { IsWindowVisible(top) != 0 }
}

fn owns_foreground(top: *mut core::ffi::c_void) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, GetForegroundWindow};

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() {
        return false;
    }
    unsafe { GetAncestor(foreground, GA_ROOT) == top }
}

/// Shows the window the way a presentation that never won activation leaves
/// it: on screen, with the foreground still somewhere else.
fn present_without_activating(top: *mut core::ffi::c_void) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_SHOWNA, ShowWindow};

    unsafe { ShowWindow(top, SW_SHOWNA) };
}

struct CloseOnDrop(SnapshotSurface);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        let _ = close_surface(self.0, deadline(10_000));
    }
}

/// A dismissal that only synthesizes Escape cannot close a surface that owns
/// no foreground, because the key is delivered to whichever window does - so
/// the surface stays up, the keystroke lands in a bystander, and every later
/// close of that surface fails identically. The close path must therefore
/// establish delivery rather than assume it, and this stages the state that
/// tells the two apart.
#[test]
fn a_presented_overflow_that_owns_no_foreground_still_closes() {
    crate::tree::fixture::bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cleanup = CloseOnDrop(SnapshotSurface::SystemTrayOverflow);

    close_surface(SnapshotSurface::SystemTrayOverflow, deadline(10_000))
        .expect("the overflow starts from a closed state");
    let Some(top) = overflow_top() else {
        eprintln!("skip stuck-overflow close: this desktop materializes no overflow window");
        return;
    };

    present_without_activating(top);
    assert!(
        settles_to(std::time::Duration::from_secs(3), true, || visible(top)),
        "the staged state is a presented overflow"
    );
    assert!(
        !owns_foreground(top),
        "the staged state is a presented overflow that owns no foreground"
    );

    close_surface(SnapshotSurface::SystemTrayOverflow, deadline(10_000))
        .expect("the close leaves the state a keystroke alone cannot leave");

    assert!(
        !visible(top),
        "the closed surface is no longer presented to the user"
    );
}

/// The opened-then-closed round trip on the same surface, so the recovery
/// above is not the only path the dismissal is measured on: the state the
/// shell's own raise leaves must close too.
#[test]
fn an_overflow_the_shell_raised_closes_and_leaves_no_foreground_behind() {
    crate::tree::fixture::bootstrap();
    let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cleanup = CloseOnDrop(SnapshotSurface::SystemTrayOverflow);

    close_surface(SnapshotSurface::SystemTrayOverflow, deadline(10_000))
        .expect("the overflow starts from a closed state");
    if open_surface(
        SnapshotSurface::SystemTrayOverflow,
        InteractionPolicy::headed(),
        deadline(10_000),
    )
    .is_err()
    {
        eprintln!("skip raised-overflow close: this desktop's shell declined the chevron raise");
        return;
    }
    let Some(top) = overflow_top() else {
        eprintln!("skip raised-overflow close: this desktop materializes no overflow window");
        return;
    };

    close_surface(SnapshotSurface::SystemTrayOverflow, deadline(10_000))
        .expect("the raised overflow closes");

    assert!(
        !visible(top),
        "the closed surface is no longer presented to the user"
    );
    assert!(
        !owns_foreground(top),
        "a dismissed surface does not keep the desktop's foreground"
    );
}
