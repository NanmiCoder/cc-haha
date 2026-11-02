use agent_desktop_core::{
    AdapterError, CURSOR_ARRIVAL_TIMEOUT_MS, CursorOverlayControl, ErrorCode,
};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::child::{MARKER, SOCKET_ENV};

const MAX_INSTRUCTION_BYTES: usize = 4 * 1024;

pub(crate) fn update(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    control.validate()?;
    if control.is_disable() || (control.is_transient() && control.agent_id().is_none()) {
        return broadcast(control);
    }
    if !control.is_transient()
        && !super::child::session_active(control.session_id(), control.agent_id())
    {
        return Ok(());
    }
    let budget = if matches!(control, CursorOverlayControl::Present { .. }) {
        CURSOR_ARRIVAL_TIMEOUT_MS
    } else {
        4_000
    };
    let deadline = Instant::now() + agent_desktop_core::Deadline::after(budget)?.remaining();
    let socket = super::endpoint::path(control.session_id(), control.agent_id())?;
    if send_until(&socket, control, deadline)? {
        return Ok(());
    }
    if control.agent_id().is_none() {
        retire_legacy(control, deadline);
    }
    if control.is_transient() {
        return Ok(());
    }
    let lock_path = super::endpoint::lock_path()?;
    let _lock = startup_lock(&lock_path, deadline)?;
    if send_until(&socket, control, deadline)? {
        return Ok(());
    }
    if !super::child::session_active(control.session_id(), control.agent_id()) {
        return Ok(());
    }
    spawn(&socket, control, deadline)
}

fn broadcast(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    let lock_path = super::endpoint::lock_path()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    let _lock = startup_lock(&lock_path, deadline)?;
    let (paths, mut first_error) = super::endpoint::discover(control.session_id())?;
    for socket in paths {
        if Instant::now() >= deadline {
            return Err(AdapterError::internal(
                "Timed out stopping macOS cursor overlays",
            ));
        }
        if let Err(error) = send_until(&socket, control, deadline) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn startup_lock(
    path: &Path,
    deadline: Instant,
) -> Result<agent_desktop_core::FileLock, AdapterError> {
    agent_desktop_core::FileLock::acquire(
        path,
        agent_desktop_core::Deadline::detached_after(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
        )?,
        "cursor overlay startup lock",
    )
}

fn spawn(
    socket: &Path,
    control: &CursorOverlayControl,
    deadline: Instant,
) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::internal(
            "Cursor overlay startup deadline elapsed",
        ));
    }
    let executable = std::env::current_exe().map_err(|error| {
        AdapterError::internal("Could not locate the cursor overlay executable")
            .with_platform_detail(error.to_string())
    })?;
    if executable.file_stem().and_then(|name| name.to_str()) != Some("agent-desktop") {
        return Ok(());
    }
    let payload = serde_json::to_vec(control).map_err(|error| {
        AdapterError::internal("Could not encode macOS cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    if payload.len() > MAX_INSTRUCTION_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cursor overlay instruction exceeds the transport limit",
        ));
    }
    let mut child = Command::new(executable)
        .env(MARKER, super::endpoint::PROTOCOL_VERSION)
        .env(SOCKET_ENV, socket)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            AdapterError::internal("Could not start the macOS cursor overlay")
                .with_platform_detail(error.to_string())
        })?;
    let Some(mut stdin) = child.stdin.take() else {
        let exited = terminate_child(&mut child);
        return Err(AdapterError::internal(if exited {
            "Cursor overlay child did not expose its input pipe"
        } else {
            "Cursor overlay child could not be reaped after startup failure"
        }));
    };
    if let Err(error) = stdin.write_all(&payload) {
        if !terminate_child(&mut child) {
            return Err(AdapterError::internal(
                "Cursor overlay child did not exit after startup failure",
            ));
        }
        return Err(
            AdapterError::internal("Could not send the cursor overlay control")
                .with_platform_detail(error.to_string()),
        );
    }
    drop(stdin);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !terminate_child(&mut child) {
        return Err(AdapterError::internal(
            "Cursor overlay child did not exit after startup failure",
        ));
    }
    Err(AdapterError::internal(
        "macOS cursor overlay did not become ready",
    ))
}

fn terminate_child(child: &mut std::process::Child) -> bool {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    super::super::process::poll_reap(child, deadline)
}

fn retire_legacy(control: &CursorOverlayControl, deadline: Instant) {
    let Ok(socket) = super::endpoint::legacy_path(control.session_id()) else {
        return;
    };
    let disable = CursorOverlayControl::disable(control.session_id().to_owned());
    let _ = send_until(&socket, &disable, deadline);
}

fn send_until(
    socket: &Path,
    control: &CursorOverlayControl,
    deadline: Instant,
) -> Result<bool, AdapterError> {
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(false);
        }
        Err(error) => {
            return Err(
                AdapterError::internal("Could not connect to the macOS cursor overlay")
                    .with_platform_detail(error.to_string()),
            );
        }
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AdapterError::internal(
            "Cursor overlay control deadline elapsed",
        ));
    }
    stream
        .set_write_timeout(Some(remaining.min(Duration::from_secs(1))))
        .map_err(|error| {
            AdapterError::internal("Could not bound the cursor overlay control write")
                .with_platform_detail(error.to_string())
        })?;
    let payload = serde_json::to_vec(control).map_err(|error| {
        AdapterError::internal("Could not encode macOS cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    if payload.len() > MAX_INSTRUCTION_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Cursor overlay instruction exceeds the transport limit",
        ));
    }
    stream.write_all(&payload).map_err(|error| {
        AdapterError::internal("Could not send the cursor overlay control")
            .with_platform_detail(error.to_string())
    })?;
    let travels = control.is_travel();
    if !control.expects_acknowledgement() {
        return Ok(true);
    }
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| {
            AdapterError::internal("Could not finish the cursor overlay control")
                .with_platform_detail(error.to_string())
        })?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let budget = if remaining.is_zero() {
        return Err(AdapterError::internal(
            "Timed out stopping macOS cursor overlays",
        ));
    } else if travels {
        remaining.min(Duration::from_millis(CURSOR_ARRIVAL_TIMEOUT_MS))
    } else {
        remaining
    };
    stream.set_read_timeout(Some(budget)).map_err(|error| {
        AdapterError::internal("Could not bound the cursor overlay acknowledgement")
            .with_platform_detail(error.to_string())
    })?;
    let mut acknowledgement = [0_u8; 1];
    match stream.read_exact(&mut acknowledgement) {
        Ok(()) => Ok(true),
        Err(error)
            if control.instruction().is_some_and(|instruction| {
                instruction.phase() == agent_desktop_core::CursorPhase::Travel
            }) =>
        {
            tracing::warn!(
                session = control.session_id(),
                agent = control.agent_id(),
                %error,
                "cursor overlay travel was not acknowledged; continuing without cursor confirmation"
            );
            Err(
                AdapterError::internal("macOS cursor overlay did not confirm cursor arrival")
                    .with_platform_detail(error.to_string()),
            )
        }
        Err(error)
            if control.instruction().is_some_and(|instruction| {
                instruction.phase() == agent_desktop_core::CursorPhase::Effect
            }) =>
        {
            tracing::warn!(
                session = control.session_id(),
                agent = control.agent_id(),
                %error,
                "cursor overlay effect was not acknowledged; continuing without effect confirmation"
            );
            Err(
                AdapterError::internal("macOS cursor overlay did not confirm cursor effect")
                    .with_platform_detail(error.to_string()),
            )
        }
        Err(error) => Err(AdapterError::internal(
            "macOS cursor overlay did not acknowledge the control",
        )
        .with_platform_detail(error.to_string())),
    }
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod tests;
