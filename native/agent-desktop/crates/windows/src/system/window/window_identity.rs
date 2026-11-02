use agent_desktop_core::{AdapterError, ErrorCode, ProcessId, WindowInfo};

use crate::system::process_identity;

/// The immutable identity evidence a resolved window must match.
///
/// Fresh-list verification is strict (title included), while stored-evidence
/// resolution treats the handle's live owner plus that owner's generation as
/// the immutable identity and tolerates title drift, logging it as telemetry -
/// a live window's title legitimately changes (a dirty-marker asterisk, an
/// Electron target retitling per document), and a hard title check there would
/// fail drill-down on the very windows this module exists to serve.
pub(crate) struct WindowIdentityEvidence<'a> {
    pub(crate) handle: super::window_enum::WindowHandle,
    pub(crate) pid: ProcessId,
    pub(crate) app: &'a str,
    pub(crate) process_instance: &'a str,
    pub(crate) title: Option<&'a str>,
}

impl<'a> WindowIdentityEvidence<'a> {
    pub(crate) fn from_info(
        handle: super::window_enum::WindowHandle,
        win: &'a WindowInfo,
    ) -> Option<Self> {
        Some(Self {
            handle,
            pid: win.pid,
            app: &win.app,
            process_instance: win.process_instance.as_deref()?,
            title: Some(&win.title),
        })
    }

    /// The strict check a window freshly listed in the same invocation
    /// receives: pid, token, app, and title must all match the live window.
    ///
    /// A recycled HWND whose process no longer matches fails closed as
    /// `WINDOW_NOT_FOUND`, never resolving to the new occupant.
    pub(crate) fn verify_strict(&self) -> Result<(), AdapterError> {
        if !process_identity::matches_instance(self.pid, self.process_instance)? {
            return Err(window_identity_mismatch(self.handle));
        }
        if !self.app.is_empty()
            && process_identity::process_image_name(self.pid).unwrap_or_default() != self.app
        {
            return Err(window_identity_mismatch(self.handle));
        }
        if self.title.is_some_and(|title| !title.is_empty()) {
            let live = live_window_title(self.handle);
            if live.as_deref() != self.title {
                return Err(window_identity_mismatch(self.handle));
            }
        }
        Ok(())
    }

    /// The stored-evidence check: the handle's live owning process is the
    /// stored pid and that process is still the stored generation; a title
    /// that drifted is logged as telemetry, not a failure.
    ///
    /// The ownership predicate is what a generation token alone cannot
    /// answer. A stored pid that is alive and unchanged says nothing about
    /// which window a recycled HWND now belongs to: an application that
    /// closes one window and keeps running leaves its process corroboration
    /// intact while the handle passes to whatever the window manager hands it
    /// to next. Without this, a stored ref would resolve into a second
    /// application's tree and every check downstream - which re-verifies the
    /// same stored pid and token - would agree it was the right one.
    pub(crate) fn verify_stored(&self) -> Result<(), AdapterError> {
        if !self.owns_handle_now()? {
            return Err(window_identity_mismatch(self.handle));
        }
        let live = live_window_title(self.handle);
        if self
            .title
            .is_some_and(|expected| live.as_deref() != Some(expected))
        {
            tracing::debug!("window title changed while immutable source identity remained valid");
        }
        Ok(())
    }

    /// Whether the handle is owned, at this instant, by the stored process
    /// *instance*: the pid that owns the handle right now, and that pid still
    /// running the generation the evidence was taken from.
    ///
    /// Both terms are load-bearing and neither substitutes for the other. The
    /// owner read alone cannot see a process that exited and had its pid
    /// handed to something else, because Windows recycles pids freely; the
    /// generation token alone cannot see a handle that passed to a different
    /// window of a still-running process. A caller that re-checks only the pid
    /// at the point of use is therefore weaker than the check that admitted
    /// the window, and a replacement that inherited both the recycled pid and
    /// the recycled handle would satisfy it. This predicate exists so the
    /// admission check and every point-of-use guard are the same test by
    /// construction rather than by convention.
    ///
    /// A hosted application's identity splits the two terms (A26-8): its
    /// listed pid is the hosted `CoreWindow`'s, while the handle it is
    /// addressed by belongs to the frame host. The fallback branch below is
    /// that split's ownership half - the handle counts as owned exactly when
    /// it is, right now, an application frame hosting that same identity's
    /// `CoreWindow`, which fails closed when the frame is gone, hosts
    /// nothing, or hosts a different application. Suspension drops the
    /// hosted `CoreWindow` while its frame survives, so a suspended
    /// application's stored identity fails here until the application
    /// resumes; that is the fail-closed answer, not a false positive.
    pub(crate) fn owns_handle_now(&self) -> Result<bool, AdapterError> {
        if live_window_owner(self.handle) == Some(self.pid) {
            return process_identity::matches_instance(self.pid, self.process_instance);
        }
        self.hosted_frame_owns_handle()
    }

    /// The hosted-frame branch of the ownership predicate: the live owner is
    /// a different process than the stored pid, which for a stored hosted
    /// identity is the frame host owning the frame the identity is addressed
    /// by. Ownership then means the handle still hosts the stored process -
    /// read fresh, never assumed - and that the stored pid is still the
    /// stored generation.
    fn hosted_frame_owns_handle(&self) -> Result<bool, AdapterError> {
        if super::frame_identity::hosted_application_pid(self.handle) != Some(self.pid) {
            return Ok(false);
        }
        process_identity::matches_instance(self.pid, self.process_instance)
    }
}

/// Reads the process that owns a window handle right now - the fact that
/// binds a handle to a pid, rather than merely asserting the pid is alive.
///
/// `None` is every kind of unanswerable: a destroyed handle, a handle the
/// window manager no longer knows, and the non-Windows lane where no window
/// server is reachable. Callers treat it as a failed match, never as an
/// absent constraint, so an unreadable owner fails closed.
///
/// The out-parameter is what decides the answer rather than the returned thread
/// id: both are zero exactly when the call fails, since an invalid handle leaves
/// the pre-zeroed variable untouched and a live window belongs to a process
/// whose id is never zero.
pub(crate) fn live_window_owner(handle: super::window_enum::WindowHandle) -> Option<ProcessId> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(handle, &mut pid) };
        if pid == 0 {
            return None;
        }
        Some(ProcessId::from(pid))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        None
    }
}

/// How long a window gets to answer the liveness ping before its title is
/// treated as unreadable.
///
/// `GetWindowTextW` sends `WM_GETTEXT` when the window belongs to the calling
/// process, so a same-process window whose thread never dispatches blocks the
/// read outright. The documented cross-process behaviour returns the caption
/// without sending, which is why this only bites in-process, but the title is
/// best-effort evidence either way - a window that will not answer simply has
/// no readable title, and identity still rests on the owner and generation
/// checks that never touch the message queue.
const TITLE_PROBE_MS: u64 = 250;

/// Reads the live title of a window handle, the one piece of the strict check
/// only the OS can answer for.
pub(crate) fn live_window_title(handle: super::window_enum::WindowHandle) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW;
        if !crate::tree::automation::window_is_pumping(handle as isize, TITLE_PROBE_MS) {
            return None;
        }
        let mut buffer = vec![0u16; 512];
        let length = unsafe { GetWindowTextW(handle, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length <= 0 {
            return None;
        }
        buffer.truncate(length as usize);
        Some(String::from_utf16_lossy(&buffer))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        None
    }
}

/// The fail-closed identity-mismatch error, carrying no window-derived text.
fn window_identity_mismatch(handle: super::window_enum::WindowHandle) -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        "The window's identity no longer matches its stored evidence",
    )
    .with_suggestion("Run 'list-windows' to refresh window identifiers, then retry.")
    .with_platform_detail(format!(
        "HWND 0x{:X} failed process-instance corroboration",
        handle as usize
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_window(pid: ProcessId, instance: &str, title: &str) -> WindowInfo {
        WindowInfo {
            id: "w-1".into(),
            title: title.into(),
            app: "fixture".into(),
            pid,
            process_instance: Some(instance.into()),
            bounds: None,
            state: Default::default(),
        }
    }

    #[test]
    fn a_shape_with_no_process_instance_fails_closed() {
        let win = WindowInfo {
            process_instance: None,
            ..fake_window(ProcessId::new(1), "x", "T")
        };
        let evidence = WindowIdentityEvidence::from_info(std::ptr::null_mut(), &win);

        assert!(
            evidence.is_none(),
            "no process instance means no corroboration possible"
        );
    }

    /// A window whose title carries a marker string must not leak it into the
    /// `WINDOW_NOT_FOUND` error when identity verification fails: the error
    /// shape is id-only by construction (handle, never title), and this pins
    /// it so it stays that way.
    #[test]
    fn a_marker_titled_window_that_fails_identity_leaks_no_marker() {
        const MARKER: &str = "unredacted-secret-marker-x7f2";
        let win = fake_window(ProcessId::new(9_999_999), "windows-proc-v1:0:0", MARKER);
        let evidence = WindowIdentityEvidence::from_info(std::ptr::null_mut(), &win)
            .expect("a process instance yields evidence");

        let error = evidence
            .verify_stored()
            .expect_err("an unrecognisable pid/token pair must fail closed");

        assert_eq!(error.code, ErrorCode::WindowNotFound);
        assert!(!error.message.contains(MARKER));
        assert!(
            error
                .details
                .as_ref()
                .is_none_or(|details| !details.to_string().contains(MARKER))
        );
        assert!(
            error
                .platform_detail
                .as_ref()
                .is_none_or(|detail| !detail.contains(MARKER))
        );
    }

    #[cfg(target_os = "windows")]
    mod windows_only {
        use super::*;
        use crate::system::window::window_enum::WindowHandle;

        const DRIFTED: &str = "a-title-no-fixture-window-carries";

        fn this_process_evidence() -> Option<(ProcessId, String, String)> {
            let pid = ProcessId::from(std::process::id());
            let token = process_identity::token_for_pid(pid).ok().flatten()?;
            Some((
                pid,
                token,
                process_identity::process_image_name(pid).unwrap_or_default(),
            ))
        }

        /// Both directions of the stored/strict split, pinned against a window
        /// this process genuinely owns - the pairing the rule is about. The
        /// stored path tolerates a title the live window does not carry
        /// because ownership and generation still hold; the strict path,
        /// which does consult the title, refuses the same drift.
        #[test]
        fn an_owned_window_passes_stored_with_a_drifted_title_and_fails_strict() {
            crate::tree::fixture::bootstrap();
            let fixture =
                crate::tree::fixture::LocalFixture::create().expect("a fixture window is created");
            let Some((pid, token, app)) = this_process_evidence() else {
                return;
            };
            let mut win = fake_window(pid, &token, DRIFTED);
            win.app = app;
            let handle = fixture.handle() as WindowHandle;
            let evidence = WindowIdentityEvidence::from_info(handle, &win)
                .expect("a process with a token derives its evidence");

            assert_eq!(
                live_window_owner(handle),
                Some(pid),
                "the fixture window is owned by the test process"
            );
            assert!(
                evidence.verify_stored().is_ok(),
                "an owned, same-generation window resolves however its title drifted"
            );

            if live_window_title(handle).as_deref() == Some(DRIFTED) {
                return;
            }
            assert!(
                evidence.verify_strict().is_err(),
                "strict verification rejects a title the live window does not have"
            );
        }

        /// The cross-process recycle shape: a handle whose live owner is a
        /// different application must fail stored verification even though
        /// the stored pid is alive and of the stored generation - which is
        /// precisely the state an application that closed one window while
        /// continuing to run leaves behind.
        #[test]
        fn a_handle_owned_by_another_process_fails_stored_verification() {
            crate::tree::fixture::bootstrap();
            let fixture =
                crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
            let Some((pid, token, app)) = this_process_evidence() else {
                return;
            };
            let mut win = fake_window(pid, &token, "");
            win.app = app;
            let handle = fixture.handle() as WindowHandle;
            let evidence = WindowIdentityEvidence::from_info(handle, &win)
                .expect("a process with a token derives its evidence");

            assert!(
                process_identity::matches_instance(pid, &token)
                    .expect("the generation check answers"),
                "the stored process is alive and of the stored generation"
            );

            let error = evidence
                .verify_stored()
                .expect_err("a handle another process owns is not the stored window");

            assert_eq!(error.code, ErrorCode::WindowNotFound);
        }
    }
}
