//! Windows-only: drives the frame-identity seam against a real hosted
//! Settings application (A26-8). The hosted Settings frame is single-
//! instanced on this build, so every staging test records whether
//! `SystemSettings.exe` was running first and, only when the test dispatched
//! `ms-settings:` itself, closes the frame it staged on the way out. Tests
//! that dispatch, send the resume input, or move the foreground hold
//! `SHELL_SURFACE_LOCK` first and the on-screen stage lock second, in the
//! crate-wide lock order: the staging input is global and must not land in
//! a surface another test holds open.
#![cfg(target_os = "windows")]

use super::hosted_application_pid;
use crate::system::app_ops::process_snapshot;
use crate::system::fixture::test_support::{
    SHELL_SURFACE_LOCK, stage_foreground, wait_for_foreground_to_settle,
};
use crate::system::process_identity::{process_image_name, token_for_pid};
use crate::system::shell::shell_surface_raise::send_chord;
use crate::system::window::window_activate::focus_window;
use crate::system::window::window_enum::{WindowHandle, enumerate_top_level};
use crate::system::window::window_identity::live_window_owner;
use crate::system::window::window_ops::{
    is_foreground_window, list_windows_live, parse_handle, window_class_name,
};
use crate::tree::fixture::bootstrap;
use agent_desktop_core::{Deadline, InteractionLease, ProcessId, WindowFilter};

const HOSTED_APP_IMAGE: &str = "SystemSettings.exe";
const FRAME_HOST_IMAGE: &str = "ApplicationFrameHost.exe";
const VK_TAB: u16 = 0x09;

use crate::system::fixture::test_time::deadline;

/// One live hosted frame: the frame's own handle, the hosted application's
/// pid, and the frame host's pid - the three-way handle/pid split between a
/// hosted window's id and its identity.
struct HostedFrameLive {
    handle: isize,
    hosted_pid: u32,
    frame_host_pid: u32,
}

/// A staged `ms-settings:` dispatch with its cleanup: a fresh Settings is
/// closed on drop (the frame's WM_CLOSE, then a bounded wait for the
/// process), a pre-existing one is left as found, and the desktop's
/// foreground is returned to whatever held it before staging.
struct StagedHosted {
    frame: Option<HostedFrameLive>,
    settings_preexisting: bool,
    previous_foreground: isize,
}

impl Drop for StagedHosted {
    fn drop(&mut self) {
        if !self.settings_preexisting {
            if let Some(frame) = self.frame.as_ref() {
                close_frame_and_wait(frame.handle, frame.hosted_pid);
            }
        }
        if self.previous_foreground != 0 {
            stage_foreground(self.previous_foreground);
        }
    }
}

fn settings_running() -> bool {
    process_snapshot()
        .expect("the process snapshot enumerates")
        .iter()
        .any(|row| row.name.eq_ignore_ascii_case(HOSTED_APP_IMAGE))
}
fn dispatch_ms_settings() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .expect("the ms-settings: dispatch runs");
}

/// The first top-level frame the shipped predicate classifies as hosting
/// SystemSettings, as (frame handle, hosted pid, frame-host pid). The
/// visitor never panics: it runs across an FFI boundary.
fn hosted_settings_frame() -> Option<(isize, u32, u32)> {
    let mut found = None;
    enumerate_top_level(|window| {
        let Some(hosted) = hosted_application_pid(window.handle) else {
            return true;
        };
        let matches = process_image_name(hosted)
            .map(|image| image.eq_ignore_ascii_case(HOSTED_APP_IMAGE))
            .unwrap_or(false);
        if !matches {
            return true;
        }
        let Some(frame_host) = live_window_owner(window.handle) else {
            return true;
        };
        found = Some((
            window.handle as isize,
            u32::from(hosted),
            u32::from(frame_host),
        ));
        false
    })
    .expect("enumeration succeeds");
    found
}

fn close_frame_and_wait(frame: isize, hosted_pid: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    unsafe { PostMessageW(frame as WindowHandle, WM_CLOSE, 0, 0) };
    let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < end {
        if process_image_name(ProcessId::from(hosted_pid)).is_none() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Dispatches `ms-settings:` (the route that materializes a frame on this
/// build - a direct spawn of the Settings executable exits silently, A26-8)
/// and completes the resume the way the shell itself does: the URI route
/// alone leaves a cold or suspended application without its `CoreWindow`
/// (measured on this build - the frame exists, the application owns no
/// window), and a real input event delivered to the foreground frame is
/// what brings the hosted application back, as a user's focus does.
fn hunt_hosted_settings_frame() -> Option<(isize, u32, u32)> {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(45);
    while std::time::Instant::now() < end {
        dispatch_ms_settings();
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(found) = hosted_settings_frame() {
            return Some(found);
        }
        for frame in uncloaked_frame_host_frames() {
            if !stage_foreground(frame) {
                continue;
            }
            if send_chord(&[], VK_TAB, deadline(15_000)).is_err() {
                continue;
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
            if let Some(found) = hosted_settings_frame() {
                return Some(found);
            }
        }
    }
    None
}

/// Dispatches `ms-settings:`, waits for a frame the predicate classifies as
/// hosting SystemSettings, and brings it to the foreground. The returned
/// guard always performs its cleanup; `frame` is `None` when the desktop did
/// not cooperate and the reason is already printed.
fn stage_hosted_settings() -> StagedHosted {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let previous_foreground = unsafe { GetForegroundWindow() } as isize;
    let settings_preexisting = settings_running();
    let mut staged = StagedHosted {
        frame: None,
        settings_preexisting,
        previous_foreground,
    };
    let Some((handle, hosted_pid, frame_host_pid)) = hunt_hosted_settings_frame() else {
        eprintln!(
            "skip hosted-frame identity: no hosted Settings frame materialized on this desktop within the staging budget"
        );
        return staged;
    };
    staged.frame = Some(HostedFrameLive {
        handle,
        hosted_pid,
        frame_host_pid,
    });
    let granted = is_foreground_window(handle as WindowHandle) || stage_foreground(handle);
    if !granted {
        eprintln!(
            "skip hosted-frame identity: the desktop declined the Settings frame the foreground"
        );
        return staged;
    }
    assert!(
        wait_for_foreground_to_settle(),
        "the desktop's foreground must settle after staging"
    );
    staged
}

/// The skip shape for a staging whose frame or foreground did not hold; the staging printed why.
fn staged_frame(staged: &StagedHosted) -> Option<&HostedFrameLive> {
    let frame = staged.frame.as_ref()?;
    if !is_foreground_window(frame.handle as WindowHandle) {
        eprintln!(
            "skip hosted-frame identity: the desktop's foreground moved off the staged frame before the read"
        );
        return None;
    }
    Some(frame)
}

/// Frames the shell owns on behalf of hosted applications: uncloaked
/// `ApplicationFrameWindow` windows whose owning process is the frame host.
/// The visitor never panics: it runs across an FFI boundary.
fn uncloaked_frame_host_frames() -> Vec<isize> {
    use super::FRAME_WINDOW_CLASS;
    let mut frames = Vec::new();
    enumerate_top_level(|window| {
        if window.cloaked || window_class_name(window.handle).as_deref() != Some(FRAME_WINDOW_CLASS)
        {
            return true;
        }
        let Some(owner) = live_window_owner(window.handle) else {
            return true;
        };
        let host_owned = process_image_name(owner)
            .map(|image| image.eq_ignore_ascii_case(FRAME_HOST_IMAGE))
            .unwrap_or(false);
        if host_owned {
            frames.push(window.handle as isize);
        }
        true
    })
    .expect("enumeration succeeds");
    frames
}

/// Both halves of the hosted identity, asserted together: the frame's handle as
/// the id, the hosted application's name and pid as the identity, and the
/// pid demonstrably not the frame host's.
#[test]
fn focused_window_reports_the_frame_handle_with_the_hosted_application_identity() {
    bootstrap();
    let _shell = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let staged = stage_hosted_settings();
    let Some(frame) = staged_frame(&staged) else {
        return;
    };
    let filter = WindowFilter {
        focused_only: true,
        app: None,
    };
    let focused = list_windows_live(&filter, deadline(15_000)).expect("the listing succeeds");
    let entry = focused
        .first()
        .expect("the staged frame is the desktop's foreground window");

    assert_eq!(
        entry.id,
        format!("w-{}", frame.handle),
        "the reported id is the frame's handle"
    );
    assert_eq!(
        u32::from(entry.pid),
        frame.hosted_pid,
        "the reported pid is the hosted application's process"
    );
    assert_ne!(
        entry.pid,
        ProcessId::from(frame.frame_host_pid),
        "the reported pid is not the frame host's"
    );
    assert!(
        entry.app.eq_ignore_ascii_case(HOSTED_APP_IMAGE),
        "the reported app is the hosted application's image name, got {}",
        entry.app
    );
    assert!(entry.state.is_focused, "the entry is stamped focused");
}

/// The listings agree as an equality: `--app` scoping resolves the hosted application to
/// exactly the identity `focused_window` reports - same pid, same id, the
/// frame's handle.
#[test]
fn list_windows_app_scoping_agrees_with_focused_window_on_a_hosted_application() {
    bootstrap();
    let _shell = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let staged = stage_hosted_settings();
    let Some(frame) = staged_frame(&staged) else {
        return;
    };
    let by_app = list_windows_live(
        &WindowFilter {
            focused_only: false,
            app: Some(String::from("SystemSettings")),
        },
        deadline(15_000),
    )
    .expect("the listing succeeds");
    assert!(
        !by_app.is_empty(),
        "--app must resolve the hosted application rather than its frame host"
    );
    let focused = list_windows_live(
        &WindowFilter {
            focused_only: true,
            app: None,
        },
        deadline(15_000),
    )
    .expect("the listing succeeds");
    let focused_entry = focused
        .first()
        .expect("the staged frame is the desktop's foreground window");

    assert_eq!(
        u32::from(focused_entry.pid),
        frame.hosted_pid,
        "focused_window reports the hosted application's pid"
    );
    for window in &by_app {
        assert_eq!(
            u32::from(window.pid),
            u32::from(focused_entry.pid),
            "one visibly focused application receives one pid"
        );
        assert_eq!(window.id, focused_entry.id, "both listings agree on the id");
    }
    assert_eq!(
        parse_handle(&focused_entry.id) as isize,
        frame.handle,
        "the id both commands agree on is the frame's handle"
    );
    assert!(
        by_app.iter().any(|window| window.id == focused_entry.id),
        "the focused identity is among the --app results"
    );
}

/// The reason the listing reports the frame: the identity `focused_window`
/// handed out is accepted by the window-operation path and focuses the
/// frame it names. The frame is already foreground after staging, so the
/// raise short-circuits by design; the call proves the handle/pid split
/// verifies as stored evidence.
#[test]
fn focus_window_succeeds_against_the_identity_focused_window_reported() {
    bootstrap();
    let _shell = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let staged = stage_hosted_settings();
    let Some(frame) = staged_frame(&staged) else {
        return;
    };
    let filter = WindowFilter {
        focused_only: true,
        app: None,
    };
    let focused = list_windows_live(&filter, deadline(15_000)).expect("the listing succeeds");
    let entry = focused
        .into_iter()
        .next()
        .expect("the staged frame is the desktop's foreground window");
    assert_eq!(
        parse_handle(&entry.id) as isize,
        frame.handle,
        "the identity carries the frame's handle"
    );

    let lease =
        InteractionLease::guarded(Deadline::after(10_000).expect("deadline"), ()).expect("lease");
    focus_window(&entry, &lease)
        .expect("focus-window succeeds against the identity focused_window returned");
    assert!(
        is_foreground_window(parse_handle(&entry.id)),
        "the frame owns the foreground after the focus"
    );
    assert_eq!(
        u32::from(entry.pid),
        frame.hosted_pid,
        "the identity that focused is the hosted application's"
    );
}

/// The hosted pid is corroborable the way every stored identity is: a live
/// hosted process yields a Windows generation token, which is what the
/// listing stores and what the hosted branch of the ownership predicate
/// re-checks at every point of use.
#[test]
fn a_live_hosted_process_yields_a_generation_token() {
    bootstrap();
    let _shell = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let staged = stage_hosted_settings();
    let Some(frame) = staged.frame.as_ref() else {
        return;
    };
    let token = token_for_pid(ProcessId::from(frame.hosted_pid))
        .expect("the token read answers")
        .expect("a live hosted process carries a generation token");
    assert!(
        token.starts_with("windows-proc-v1:"),
        "the token is the Windows generation shape, got {token}"
    );
}
