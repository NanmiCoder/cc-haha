use agent_desktop_core::{AdapterError, AppError, Deadline, DeliverySemantics};
use std::io::{BufReader, BufWriter, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn forward(
    cli: &crate::Cli,
    command: &crate::Commands,
) -> Result<serde_json::Value, AppError> {
    let args = std::env::args_os()
        .skip(1)
        .map(|arg| {
            arg.into_string()
                .map_err(|_| AppError::invalid_input("Host arguments must be UTF-8"))
        })
        .collect::<Result<_, _>>()?;
    forward_args(cli, command, args, None)
}

pub(super) fn forward_args(
    cli: &crate::Cli,
    command: &crate::Commands,
    args: Vec<String>,
    baseline: Option<agent_desktop_core::SignalBaseline>,
) -> Result<serde_json::Value, AppError> {
    let expires_ns = super::budget::expires_at(cli, command).map_err(crate::pre_dispatch_error)?;
    agent_desktop_core::validate_state_root_env()?;
    let session = agent_desktop_core::session::resolve_active_session(
        cli.identity.session.as_deref(),
        std::env::var("AGENT_DESKTOP_SESSION").ok().as_deref(),
    )?;
    let identity = super::endpoint::identity(session.as_deref())?;
    let path = super::endpoint::path(&identity)?;
    let request = super::request::HostRequest {
        expires_ns,
        identity,
        args,
        baseline,
        directory: std::env::current_dir()?,
        agent_id: cli
            .identity
            .agent_id
            .clone()
            .or_else(|| std::env::var("AGENT_DESKTOP_AGENT_ID").ok()),
    };
    let mut payload = serde_json::to_vec(&request)?;
    payload.push(b'\n');
    if payload.len() > super::MAX_REQUEST_BYTES as usize {
        return Err(AppError::invalid_input(
            "Command host request exceeds its size limit",
        ));
    }
    let remaining = super::budget::remaining(expires_ns).map_err(crate::pre_dispatch_error)?;
    let stream = connect_or_start(&path, session.as_deref(), remaining.min(super::IO_TIMEOUT))
        .map_err(crate::pre_dispatch_error)?;
    let remaining = super::budget::remaining(expires_ns).map_err(crate::pre_dispatch_error)?;
    exchange(stream, &payload, remaining).map_err(|error| {
        AdapterError::internal("Command host reply was lost; the command may have executed")
            .with_platform_detail(error.to_string())
            .with_disposition(DeliverySemantics::uncertain())
            .into()
    })
}

fn exchange(
    stream: UnixStream,
    payload: &[u8],
    remaining: Duration,
) -> Result<serde_json::Value, AppError> {
    let reply_deadline = Instant::now() + remaining + Duration::from_secs(2);
    let mut output = BufWriter::new(super::output::BoundedWriter::new(
        stream.try_clone()?,
        remaining.min(super::IO_TIMEOUT),
    )?);
    output.write_all(payload)?;
    output.flush()?;
    let reply = super::input::read_frame(
        &mut BufReader::new(stream),
        64 * 1024 * 1024,
        reply_deadline.saturating_duration_since(Instant::now()),
        super::IO_TIMEOUT,
    )?;
    if reply.last() != Some(&b'\n') || reply.len() > 64 * 1024 * 1024 {
        return Err(AppError::invalid_input(
            "Command host reply is incomplete or oversized",
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&reply)?;
    if value["version"] != agent_desktop_core::response::output::ENVELOPE_VERSION
        || !value["ok"].is_boolean()
    {
        return Err(AppError::invalid_input(
            "Command host reply has an invalid envelope",
        ));
    }
    Ok(value)
}

fn connect(path: &Path, deadline: Instant) -> Result<Option<UnixStream>, AppError> {
    if !super::endpoint::validate_socket(path)? {
        return Ok(None);
    }
    match super::connect::connect(path, deadline) {
        Ok(stream) => Ok(Some(stream)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

fn connect_or_start(
    path: &Path,
    session: Option<&str>,
    budget: Duration,
) -> Result<UnixStream, AppError> {
    let deadline = Instant::now() + budget;
    if let Some(stream) = connect(path, deadline)? {
        return Ok(stream);
    }
    let _startup = agent_desktop_core::FileLock::acquire(
        &path.with_extension("start.lock"),
        Deadline::from_duration(deadline.saturating_duration_since(Instant::now()))?,
        "command host startup",
    )?;
    if let Some(stream) = connect(path, deadline)? {
        return Ok(stream);
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .env("AGENT_DESKTOP_INTERNAL_COMMAND_HOST", "1")
        .env("AGENT_DESKTOP_INTERNAL_HOST_SOCKET", path)
        .env_remove("AGENT_DESKTOP_AGENT_ID")
        .env_remove("AGENT_DESKTOP_SESSION")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(session) = session {
        command.env("AGENT_DESKTOP_SESSION", session);
    }
    let mut child = command.spawn()?;
    let result = loop {
        if Instant::now() >= deadline {
            break Err(AppError::from(AdapterError::timeout(
                "Command host startup timed out",
            )));
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                break Err(AppError::Internal(
                    "Command host exited during startup".into(),
                ));
            }
            Ok(None) => {}
            Err(error) => break Err(error.into()),
        }
        match connect(path, deadline) {
            Ok(Some(stream)) => break Ok(stream),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => break Err(error),
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn replied(bytes: &[u8]) -> Result<serde_json::Value, AppError> {
        let bytes = bytes.to_vec();
        let (client, mut server) = UnixStream::pair().unwrap();
        std::thread::spawn(move || {
            let mut request = [0_u8; 64];
            let _ = server.read(&mut request);
            let _ = server.write_all(&bytes);
        });
        exchange(client, b"{}\n", Duration::from_secs(30))
    }

    #[test]
    fn a_reply_without_its_newline_boundary_is_rejected() {
        let error = replied(br#"{"version":"2.5","ok":true}"#).unwrap_err();
        assert!(error.to_string().contains("incomplete or oversized"));
    }

    #[test]
    fn a_reply_with_an_invalid_envelope_is_rejected() {
        for reply in [
            br#"{"version":"9.9","ok":true}"#.as_slice(),
            br#"{"version":"2.5","ok":"yes"}"#.as_slice(),
            br#"{"version":"2.5"}"#.as_slice(),
        ] {
            let mut framed = reply.to_vec();
            framed.push(b'\n');
            let error = replied(&framed).unwrap_err();
            assert!(error.to_string().contains("invalid envelope"));
        }
    }
}
