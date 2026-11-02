use agent_desktop_core::{AdapterError, Deadline, InteractionPolicy, KeyCombo, ProcessIdentity};

const CLEANUP_TIMEOUT_MS: u64 = 2_000;

pub(crate) fn close_session<T>(
    session: NcSession,
    result: Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    merge_session_result(result, session.close())
}

fn merge_session_result<T>(
    result: Result<T, AdapterError>,
    cleanup: Result<(), AdapterError>,
) -> Result<T, AdapterError> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(close_err)) => Err(close_err),
        (Err(err), Ok(())) => Err(err),
        (Err(err), Err(close_err)) => {
            tracing::warn!(error = %close_err, "notification center cleanup also failed after the operation failed");
            Err(err)
        }
    }
}

pub(crate) struct NcSession {
    pid: i32,
    close_pending: bool,
    previous_app: Option<ProcessIdentity>,
    cleanup_on_drop: bool,
}

struct NcSessionOps<Open, WaitUntilReady, Close, Reactivate>
where
    Open: FnMut(Deadline) -> Result<(), AdapterError>,
    WaitUntilReady: FnMut(Deadline) -> Result<i32, AdapterError>,
    Close: FnMut(Deadline) -> Result<(), AdapterError>,
    Reactivate: FnMut(&ProcessIdentity, Deadline) -> Result<(), AdapterError>,
{
    open: Open,
    wait_until_ready: WaitUntilReady,
    close: Close,
    reactivate: Reactivate,
}

impl NcSession {
    pub(crate) fn open(
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        if let Some(pid) = nc_pid(deadline)?
            && is_nc_open(pid, deadline)
        {
            return Ok(Self {
                pid,
                close_pending: false,
                previous_app: None,
                cleanup_on_drop: true,
            });
        }
        if !policy.is_headed() {
            return Err(closed_center_policy_error(policy));
        }
        let previous_app = frontmost_app(deadline)?;
        crate::system::permissions::require_automation_permission()?;
        Self::open_with(
            previous_app,
            deadline,
            NcSessionOps {
                open: open_nc,
                wait_until_ready: wait_for_nc_ready,
                close: close_nc,
                reactivate: reactivate_app,
            },
        )
    }

    fn open_with<Open, WaitUntilReady, Close, Reactivate>(
        previous_app: Option<ProcessIdentity>,
        deadline: Deadline,
        mut ops: NcSessionOps<Open, WaitUntilReady, Close, Reactivate>,
    ) -> Result<Self, AdapterError>
    where
        Open: FnMut(Deadline) -> Result<(), AdapterError>,
        WaitUntilReady: FnMut(Deadline) -> Result<i32, AdapterError>,
        Close: FnMut(Deadline) -> Result<(), AdapterError>,
        Reactivate: FnMut(&ProcessIdentity, Deadline) -> Result<(), AdapterError>,
    {
        let mut session = Self {
            pid: 0,
            close_pending: true,
            previous_app,
            cleanup_on_drop: true,
        };
        let result = (ops.open)(deadline).and_then(|()| (ops.wait_until_ready)(deadline));
        match result {
            Ok(pid) => {
                session.pid = pid;
                Ok(session)
            }
            Err(error) => {
                let cleanup = session.cleanup_with(ops.close, ops.reactivate);
                merge_session_result(Err(error), cleanup)
            }
        }
    }

    pub(crate) fn pid(&self) -> i32 {
        self.pid
    }

    pub(crate) fn close(mut self) -> Result<(), AdapterError> {
        self.close_with(close_nc, reactivate_app)
    }

    fn close_with(
        &mut self,
        mut close: impl FnMut(Deadline) -> Result<(), AdapterError>,
        mut reactivate: impl FnMut(&ProcessIdentity, Deadline) -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        let first = self.cleanup_with(&mut close, &mut reactivate);
        let result = if first.is_err() && self.has_pending_cleanup() {
            self.cleanup_with(close, reactivate)
        } else {
            first
        };
        self.cleanup_on_drop = false;
        result
    }

    fn cleanup_with(
        &mut self,
        mut close: impl FnMut(Deadline) -> Result<(), AdapterError>,
        mut reactivate: impl FnMut(&ProcessIdentity, Deadline) -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        let close_result = if self.close_pending {
            close(Deadline::detached_after(CLEANUP_TIMEOUT_MS)?)
                .inspect(|()| self.close_pending = false)
        } else {
            Ok(())
        };
        let restore_result = if let Some(app) = self.previous_app.as_ref() {
            reactivate(app, Deadline::detached_after(CLEANUP_TIMEOUT_MS)?)
                .inspect(|()| self.previous_app = None)
        } else {
            Ok(())
        };
        merge_cleanup_results(close_result, restore_result)
    }

    fn has_pending_cleanup(&self) -> bool {
        self.close_pending || self.previous_app.is_some()
    }
}

fn closed_center_policy_error(policy: InteractionPolicy) -> AdapterError {
    AdapterError::policy_denied_for_policy(
        "Notification Center is closed and observation cannot open it in headless mode",
        policy,
    )
    .with_suggestion(
        "Open Notification Center yourself or pass --headed to allow opening and restoring desktop focus.",
    )
}

impl Drop for NcSession {
    fn drop(&mut self) {
        if !self.cleanup_on_drop {
            return;
        }
        if let Err(error) = self.cleanup_with(close_nc, reactivate_app) {
            tracing::warn!(%error, "Notification Center cleanup retry failed in Drop");
        }
    }
}

#[cfg(target_os = "macos")]
fn frontmost_app(deadline: Deadline) -> Result<Option<ProcessIdentity>, AdapterError> {
    let snapshot = crate::system::app::workspace_apps::window_owner_snapshot_until(
        operation_deadline(deadline, std::time::Duration::from_secs(2))?,
    )?;
    let Some(owner) = snapshot.frontmost() else {
        return Ok(None);
    };
    let Some(instance) = crate::system::process::process_identity::token_for_pid(owner.pid)? else {
        return Ok(None);
    };
    Ok(Some(ProcessIdentity::new(
        crate::system::process::process_identity::from_pid_t(owner.pid)?,
        instance,
    )))
}

#[cfg(not(target_os = "macos"))]
fn frontmost_app(_deadline: Deadline) -> Result<Option<ProcessIdentity>, AdapterError> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn reactivate_app(app: &ProcessIdentity, deadline: Deadline) -> Result<(), AdapterError> {
    let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
    if !crate::system::process::process_identity::matches_instance(pid, &app.instance)? {
        return Ok(());
    }
    crate::system::focus::ensure_app_focused(pid, deadline)
}

#[cfg(not(target_os = "macos"))]
fn reactivate_app(_app: &ProcessIdentity, _deadline: Deadline) -> Result<(), AdapterError> {
    Ok(())
}

fn merge_cleanup_results(
    close: Result<(), AdapterError>,
    restore: Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    match (close, restore) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(restore_error)) => {
            tracing::warn!(error = %restore_error, "focus restoration also failed during Notification Center cleanup");
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
fn nc_pid(deadline: Deadline) -> Result<Option<i32>, AdapterError> {
    let mut command = std::process::Command::new("/usr/bin/pgrep");
    command.arg("-x").arg("NotificationCenter");
    let output = crate::system::process::run_with_deadline(
        &mut command,
        "pgrep NotificationCenter",
        operation_deadline(deadline, std::time::Duration::from_secs(1))?,
    );
    nc_pid_from_output(output)
}

#[cfg(target_os = "macos")]
fn nc_pid_from_output(
    output: Result<std::process::Output, AdapterError>,
) -> Result<Option<i32>, AdapterError> {
    let output = output?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()
        .and_then(|line| line.trim().parse::<i32>().ok()))
}

#[cfg(target_os = "macos")]
fn is_nc_open(pid: i32, deadline: Deadline) -> bool {
    use crate::tree::element_for_pid;

    let app = element_for_pid(pid);
    let windows = crate::notifications::read::children_for_attribute(&app, "AXWindows", deadline)
        .unwrap_or_default();
    !windows.is_empty()
}

#[cfg(not(target_os = "macos"))]
fn nc_pid(_deadline: Deadline) -> Result<Option<i32>, AdapterError> {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
fn is_nc_open(_pid: i32, _deadline: Deadline) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn open_nc(deadline: Deadline) -> Result<(), AdapterError> {
    let script = r#"tell application "System Events" to tell its application process "ControlCenter"
        click (first menu bar item of menu bar 1 whose description is "Clock")
    end tell"#;

    let mut command = std::process::Command::new("/usr/bin/osascript");
    command.arg("-e").arg(script);
    let output = crate::system::process::run_with_deadline(
        &mut command,
        "osascript open-nc",
        operation_deadline(deadline, std::time::Duration::from_secs(2))?,
    )?;
    if !output.status.success() {
        return Err(crate::system::permissions::map_automation_command_failure(
            output.status,
            &output.stderr,
        ));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_nc(_deadline: Deadline) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("open_nc"))
}

#[cfg(target_os = "macos")]
fn close_nc(deadline: Deadline) -> Result<(), AdapterError> {
    use crate::input::keyboard;

    let Some(pid) = nc_pid(deadline)? else {
        return Ok(());
    };
    if !is_nc_open(pid, deadline) {
        return Ok(());
    }
    let combo = KeyCombo {
        key: "escape".into(),
        modifiers: vec![],
    };
    keyboard::synthesize_key(&combo, None, deadline)?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
#[path = "nc_session_tests.rs"]
mod tests;

#[cfg(not(target_os = "macos"))]
fn close_nc(_deadline: Deadline) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("close_nc"))
}

#[cfg(target_os = "macos")]
fn wait_for_nc_ready(deadline: Deadline) -> Result<i32, AdapterError> {
    let poll = std::time::Duration::from_millis(50);

    loop {
        if let Some(pid) = nc_pid(deadline)? {
            if is_nc_open(pid, deadline) {
                return Ok(pid);
            }
        }
        if deadline.is_expired() {
            return Err(AdapterError::timeout(
                "Notification Center did not open within the operation deadline",
            ));
        }
        std::thread::sleep(poll.min(deadline.remaining()));
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_nc_ready(_deadline: Deadline) -> Result<i32, AdapterError> {
    Err(AdapterError::not_supported("wait_for_nc_ready"))
}

fn operation_deadline(
    deadline: Deadline,
    maximum: std::time::Duration,
) -> Result<std::time::Instant, AdapterError> {
    let remaining = deadline.remaining();
    if remaining.is_zero() {
        Err(deadline.timeout_error())
    } else {
        std::time::Instant::now()
            .checked_add(remaining.min(maximum))
            .ok_or_else(|| AdapterError::timeout("Notification subprocess deadline overflowed"))
    }
}
