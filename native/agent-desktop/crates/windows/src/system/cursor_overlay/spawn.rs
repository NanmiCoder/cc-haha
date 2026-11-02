//! Reaching the renderer for a session, and starting one when there is none.
//!
//! Connect first, classify a failure before acting on it, and spawn only for
//! a control that may bring a renderer into existence. A `Disable` that
//! spawned would start a renderer in order to tell it to stop, and dispatch
//! sends `Hide`/`Show` around every mutating command in a headed session —
//! which would fork a detached renderer per command.

use std::time::Duration;

use agent_desktop_core::{AdapterError, CursorOverlayControl, ErrorCode};

use super::discover;
use super::framing;
use super::pipe_name;
use super::retire;
use super::transport::{self, ReachOutcome};

/// Matches the arrival ceiling core already imposes on a travel, and is what
/// a fresh renderer has to get its window up inside.
const ENABLE_BUDGET: Duration =
    Duration::from_millis(agent_desktop_core::CURSOR_ARRIVAL_TIMEOUT_MS);

/// Teardown is allowed longer, because a caller of `disable` is waiting for
/// the window to be gone rather than for a frame to land.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(4);

/// The stale-generation sweep runs here — before the reach on the current
/// name — rather than on the spawn path below. A sweep further down would miss
/// the case that motivates it: both generations alive at once, the current one
/// answering, so the reach returns `Delivered` and the spawn path is never
/// taken while the earlier generation's window is still drawn.
///
/// It runs on `Disable` as well as `Enable`, because `broadcast` reaches the
/// endpoints `discover` can name and a retired generation's pipe is not one of
/// them. An operator ending a session means all of it; leaving the earlier
/// generation's window drawn is the one outcome teardown must not produce.
pub(crate) fn update(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    control.validate()?;
    let root = state_root()?;
    let budget = budget_for(control);

    if sweeps_retired_generations(control) {
        retire::sweep(&root, control.session_id());
    }

    if control.is_disable() {
        return broadcast(&root, control, budget);
    }

    let name = pipe_name::pipe_name(&root, control.session_id(), control.agent_id());

    match transport::reach(&name, control, budget) {
        ReachOutcome::Delivered => return Ok(()),
        ReachOutcome::Unreachable(error) => return Err(error),
        ReachOutcome::NoRenderer => {}
    }

    if !framing::may_spawn(control) {
        return Ok(());
    }

    start_renderer(&name, control, budget)
}

/// Stops every cursor the session is drawing, not just the one an agent id
/// would name.
///
/// A `Disable` carries no agent, which is the contract rather than an
/// oversight: an operator ending a session means all of it, and the agents
/// that drew inside it are not theirs to enumerate. So the endpoints are
/// discovered and each is told to stop.
///
/// The first refusal is reported and the rest are still attempted. Returning
/// at the first one would leave the remaining cursors on screen while the
/// caller was told teardown failed, which is the worst of both: an error, and
/// the windows still up.
fn broadcast(
    root: &std::path::Path,
    control: &CursorOverlayControl,
    budget: Duration,
) -> Result<(), AdapterError> {
    let mut first_error = None;
    for name in discover::session_endpoints(root, control.session_id()) {
        match transport::reach(&name, control, budget) {
            ReachOutcome::Delivered | ReachOutcome::NoRenderer => {}
            ReachOutcome::Unreachable(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Which controls clear retired protocol generations.
///
/// Establishing a session and ending one both have to. A control inside a
/// live session does not, and sweeping on those would reach retired pipes on
/// every mutating command. Pure, so the choice can be asserted without a
/// renderer to aim at.
fn sweeps_retired_generations(control: &CursorOverlayControl) -> bool {
    control.is_enable() || control.is_disable()
}

fn budget_for(control: &CursorOverlayControl) -> Duration {
    if control.is_disable() {
        TEARDOWN_BUDGET
    } else {
        ENABLE_BUDGET
    }
}

/// How long a reach must have left to be worth making at all.
///
/// A reach handed what is nearly nothing does not fail fast — it connects,
/// writes, and then gives up waiting for the acknowledgement a renderer that
/// has just come up is about to send, reporting an acknowledgement timeout for
/// what is really an exhausted start-up budget. `WaitNamedPipeW` is worse
/// still: a wait of zero milliseconds means "use the server's own default",
/// so a remaining budget that rounds to zero would park past the deadline
/// instead of inside it.
const MINIMUM_REACH: Duration = Duration::from_millis(16);

const RETRY_INTERVAL: Duration = Duration::from_millis(8);
/// The retry pause doubles from `RETRY_INTERVAL` up to this ceiling: a
/// renderer that is merely slow to register its pipe is caught by the first
/// few polls, and one that is not coming stops being asked sixty times a
/// second for the rest of the budget.
const MAXIMUM_RETRY_INTERVAL: Duration = Duration::from_millis(128);

/// Reaches until a renderer answers or the budget is gone, handing each
/// attempt what is actually left rather than the full budget again.
///
/// Re-issuing the whole budget per attempt is not a rounding error: one reach
/// that spends its ceiling waiting on a renderer that never came up is
/// followed by another with the same ceiling, so a caller told `rendered:
/// false` has waited roughly twice the arrival timeout core promised it.
///
/// The loop always leaves by the start-up timeout rather than by a transport
/// error, because "the renderer did not come up" is what a caller can act on;
/// which Win32 call the last doomed attempt happened to give up in is not.
fn retry_until_reached(
    deadline: std::time::Instant,
    mut reach: impl FnMut(Duration) -> ReachOutcome,
) -> Result<(), AdapterError> {
    let mut pause = RETRY_INTERVAL;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining < MINIMUM_REACH {
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                "The cursor overlay renderer did not come up within its budget",
            ));
        }
        match reach(remaining) {
            ReachOutcome::Delivered => return Ok(()),
            ReachOutcome::Unreachable(error) => return Err(error),
            ReachOutcome::NoRenderer => {}
        }
        std::thread::sleep(pause.min(remaining));
        pause = (pause * 2).min(MAXIMUM_RETRY_INTERVAL);
    }
}

fn state_root() -> Result<std::path::PathBuf, AdapterError> {
    agent_desktop_core::session::agent_desktop_dir()
        .map_err(|error| AdapterError::new(ErrorCode::InvalidArgs, error.to_string()))
}

#[cfg(target_os = "windows")]
fn start_renderer(
    name: &str,
    control: &CursorOverlayControl,
    budget: Duration,
) -> Result<(), AdapterError> {
    imp::start_renderer(name, control, budget)
}

#[cfg(not(target_os = "windows"))]
fn start_renderer(
    _name: &str,
    _control: &CursorOverlayControl,
    _budget: Duration,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("update_cursor_overlay"))
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{pipe_name, transport};
    use crate::system::cursor_overlay::image_identity;
    use crate::system::cursor_overlay::wide::{wide, win32_error};
    use agent_desktop_core::{AdapterError, CursorOverlayControl};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    /// Spawns only from the CLI's own image. Under an FFI host
    /// `current_exe()` is the host process, which must never be re-launched
    /// as a renderer, and a test binary must not fork one either.
    ///
    /// The refusal is an `Err` rather than macOS's `Ok(())`, because
    /// dispatch turns `Ok` into `rendered: true` - which would claim an
    /// overlay that was never started.
    ///
    /// The image test is the one a client applies to a pipe server it found,
    /// so what may be forked and what may be trusted cannot drift apart.
    fn executable() -> Result<std::path::PathBuf, AdapterError> {
        let path = std::env::current_exe().map_err(|error| {
            AdapterError::internal("The running executable could not be resolved")
                .with_platform_detail(error.to_string())
        })?;
        if !image_identity::is_agent_desktop_image(&path) {
            let stem = image_identity::image_stem(&path).unwrap_or_default();
            let wanted = image_identity::IMAGE_STEM;
            return Err(
                AdapterError::not_supported("update_cursor_overlay").with_platform_detail(format!(
                    "the overlay renderer is only started from the {wanted} image, not '{stem}'"
                )),
            );
        }
        Ok(path)
    }

    /// Starts the renderer with **no inherited handles at all**.
    ///
    /// This is why the spawn is a raw `CreateProcessW` rather than
    /// `std::process::Command`: `Command` passes `bInheritHandles = TRUE`
    /// whenever it configures stdio, and does not restrict what is
    /// inherited. A detached renderer that inherits its caller's stdout
    /// keeps that pipe open for its whole life, so any shell reading the
    /// command's output blocks until the overlay is torn down - measured,
    /// and the reason this path looks like `launch.rs` rather than like the
    /// macOS spawn it otherwise mirrors.
    ///
    /// Losing the inherited stdin costs nothing: the control that started
    /// the child is delivered again over the pipe by `await_renderer`, which
    /// has to connect anyway to read the acknowledgement.
    pub(super) fn start_renderer(
        name: &str,
        control: &CursorOverlayControl,
        budget: Duration,
    ) -> Result<(), AdapterError> {
        let image = executable()?;
        let mut command_line = wide(&format!(
            "\"{}\" {}",
            image.display(),
            pipe_name::child_arguments(control.session_id(), control.agent_id()).join(" ")
        ));
        let mut environment = child_environment();

        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let started = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_mut_ptr().cast(),
                std::ptr::null(),
                &startup,
                &mut information,
            )
        };
        if started == 0 {
            return Err(win32_error(
                "The cursor overlay renderer could not be started",
            ));
        }
        unsafe {
            CloseHandle(information.hThread);
            CloseHandle(information.hProcess);
        }

        await_renderer(name, control, budget)
    }

    /// This process's environment plus the marker that turns the child into
    /// a renderer, as the double-null-terminated block `CreateProcessW`
    /// wants.
    fn child_environment() -> Vec<u16> {
        let mut block: Vec<u16> = Vec::new();
        for (key, value) in std::env::vars() {
            if key.eq_ignore_ascii_case(pipe_name::CHILD_MARKER) {
                continue;
            }
            block.extend(format!("{key}={value}").encode_utf16());
            block.push(0);
        }
        block.extend(
            format!(
                "{}={}",
                pipe_name::CHILD_MARKER,
                pipe_name::PROTOCOL_GENERATION
            )
            .encode_utf16(),
        );
        block.push(0);
        block.push(0);
        block
    }

    /// The control that started the child is delivered here, over the pipe,
    /// once the child has claimed its name and shown its window. Nothing is
    /// carried on stdin, so nothing of the caller's is inherited.
    fn await_renderer(
        name: &str,
        control: &CursorOverlayControl,
        budget: Duration,
    ) -> Result<(), AdapterError> {
        super::retry_until_reached(Instant::now() + budget, |remaining| {
            transport::reach(name, control, remaining)
        })
    }
}
#[cfg(test)]
#[path = "spawn_tests.rs"]
mod tests;
