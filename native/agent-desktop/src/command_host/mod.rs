use agent_desktop_core::{AppError, response::output::Response, session::resolve_active_session};
use clap::Parser;
use std::io::Write;
#[cfg(test)]
use std::io::{BufRead, Read};
use std::os::fd::AsFd;

const MAX_REQUEST_BYTES: u64 = 1_048_576;
const RETAINED_PRUNE_INTERVAL: usize = 4_096;
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);
const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub(crate) fn is_host_process() -> bool {
    std::env::var("AGENT_DESKTOP_INTERNAL_COMMAND_HOST").as_deref() == Ok("1")
}

#[path = "command_host_batch.rs"]
mod batch;
pub(crate) use batch::forward_batch_item;

#[path = "command_host_budget.rs"]
mod budget;

#[path = "command_host_client.rs"]
mod client;
#[path = "command_host_connect.rs"]
mod connect;
#[path = "command_host_endpoint.rs"]
mod endpoint;
#[path = "command_host_input.rs"]
mod input;
#[path = "command_host_output.rs"]
mod output;
#[path = "command_host_request.rs"]
mod request;
#[path = "command_host_socket.rs"]
mod socket;
#[cfg(test)]
#[path = "command_host_test_dir.rs"]
mod test_dir;

pub(crate) fn forward(
    cli: &crate::Cli,
    command: &crate::Commands,
) -> Result<serde_json::Value, AppError> {
    client::forward(cli, command)
}

pub(crate) fn run() -> Result<(), AppError> {
    let session =
        resolve_active_session(None, std::env::var("AGENT_DESKTOP_SESSION").ok().as_deref())?;
    let owner = agent_desktop_macos::RetainedRefSession::start()?;
    let store = agent_desktop_core::refs::refs_store::RefStore::for_session(session.as_deref())?;
    let mut next_prune = RETAINED_PRUNE_INTERVAL;
    let identity = endpoint::identity(session.as_deref())?;
    let socket_path = std::env::var_os("AGENT_DESKTOP_INTERNAL_HOST_SOCKET");
    let reported_missing_permission = std::cell::Cell::new(false);
    let execute = |bytes: &[u8]| {
        if owner.capture_count() >= next_prune {
            match store.retained_object_tokens() {
                Ok(tokens) => owner.retain(&tokens),
                Err(error) => {
                    tracing::warn!(%error, "retained-token inventory failed; pruning deferred");
                }
            }
            next_prune = owner
                .capture_count()
                .saturating_add(RETAINED_PRUNE_INTERVAL);
        }
        let response = if socket_path.is_some() {
            request::execute(bytes, &identity, session.as_deref())
        } else {
            execute_request(bytes, session.as_deref())
        };
        if reports_missing_permission(&response) {
            reported_missing_permission.set(true);
        }
        response
    };
    if let Some(ref path) = socket_path {
        return socket::run(std::path::Path::new(&path), execute, || {
            reported_missing_permission.get()
        });
    }
    let input = std::io::stdin();
    let output = std::fs::File::from(std::io::stdout().as_fd().try_clone_to_owned()?);
    let mut input = std::io::BufReader::new(input.lock());
    serve_frames(
        || {
            input::read_frame(
                &mut input,
                MAX_REQUEST_BYTES as usize,
                IDLE_TIMEOUT,
                IO_TIMEOUT,
            )
        },
        std::io::BufWriter::new(output::BoundedWriter::new(output, IO_TIMEOUT)?),
        execute,
    )?;
    Ok(())
}

/// macOS keeps the Accessibility answer a process read before a grant, so a
/// host that told a caller a permission is missing exits after that reply and
/// the next call starts a host that sees the new grant.
fn reports_missing_permission(response: &Response) -> bool {
    let denied = |report: &serde_json::Value| report["accessibility"]["state"] == "denied";
    response
        .error
        .as_ref()
        .is_some_and(|error| error.code == "PERM_DENIED")
        || response
            .data
            .as_ref()
            .is_some_and(|data| denied(data) || denied(&data["permissions"]))
}

fn execute_request(bytes: &[u8], session: Option<&str>) -> Response {
    let result = parse_request(bytes, session);
    match result {
        Ok((cli, command)) => {
            let name = command.name();
            crate::response(name, crate::execute(cli, command))
        }
        Err(error) => crate::response("unknown", Err(error)),
    }
}

fn parse_request(
    bytes: &[u8],
    session: Option<&str>,
) -> Result<(crate::Cli, crate::Commands), AppError> {
    let args: Vec<String> = serde_json::from_slice(bytes).map_err(|_| {
        AppError::invalid_input("Host request must be a JSON array of CLI arguments")
    })?;
    let mut cli =
        crate::Cli::try_parse_from(std::iter::once("agent-desktop".to_owned()).chain(args))
            .map_err(|error| {
                AppError::invalid_input(crate::diagnostic::bounded_text(&error.to_string(), 512))
            })?;
    let selected = resolve_active_session(cli.identity.session.as_deref(), session)?;
    if selected.as_deref() != session {
        return Err(AppError::invalid_input(
            "A command host cannot switch snapshot namespaces",
        ));
    }
    let command = cli
        .command
        .take()
        .ok_or_else(|| AppError::invalid_input("Host request requires a command"))?;
    Ok((cli, command))
}

#[cfg(test)]
fn serve(
    mut input: impl BufRead,
    output: impl Write,
    execute: impl FnMut(&[u8]) -> Response,
) -> Result<(), AppError> {
    serve_frames(
        || {
            let mut bytes = Vec::new();
            input
                .by_ref()
                .take(MAX_REQUEST_BYTES + 1)
                .read_until(b'\n', &mut bytes)?;
            Ok(bytes)
        },
        output,
        execute,
    )
}

fn serve_frames(
    mut read_frame: impl FnMut() -> std::io::Result<Vec<u8>>,
    mut output: impl Write,
    mut execute: impl FnMut(&[u8]) -> Response,
) -> Result<(), AppError> {
    loop {
        let bytes = read_frame().map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                AppError::Adapter(
                    agent_desktop_core::AdapterError::timeout(
                        "Command host request did not arrive before its input deadline",
                    )
                    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()),
                )
            } else {
                AppError::from(error)
            }
        })?;
        if bytes.is_empty() {
            return Ok(());
        }
        let oversized = bytes.len() as u64 > MAX_REQUEST_BYTES;
        let incomplete = bytes.last() != Some(&b'\n');
        let response = if oversized || incomplete {
            crate::response(
                "unknown",
                Err(AppError::invalid_input(
                    "Host request is oversized or lacks its newline terminator",
                )),
            )
        } else {
            execute(&bytes)
        };
        serde_json::to_writer(&mut output, &response).map_err(|error| {
            std::io::Error::new(
                error.io_error_kind().unwrap_or(std::io::ErrorKind::Other),
                error,
            )
        })?;
        output.write_all(b"\n")?;
        output.flush()?;
        if oversized || incomplete {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_stops_after_it_reports_a_missing_permission() {
        let report = |accessibility: &str| serde_json::json!({ "accessibility": { "state": accessibility } });
        assert!(reports_missing_permission(&Response::ok(
            "permissions",
            report("denied")
        )));
        assert!(reports_missing_permission(&Response::ok(
            "status",
            serde_json::json!({ "permissions": report("denied") })
        )));
        assert!(reports_missing_permission(&crate::response(
            "snapshot",
            Err(AppError::Adapter(
                agent_desktop_core::AdapterError::permission_denied()
            ))
        )));
        assert!(!reports_missing_permission(&Response::ok(
            "permissions",
            report("granted")
        )));
        assert!(!reports_missing_permission(&Response::ok(
            "version",
            serde_json::json!({})
        )));
    }

    #[test]
    fn repeated_commands_reuse_dispatch_and_preserve_envelopes() {
        let mut output = Vec::new();
        serve(
            std::io::Cursor::new(b"[\"version\"]\n[\"version\"]\n"),
            &mut output,
            |bytes| execute_request(bytes, None),
        )
        .unwrap();
        let responses: Vec<serde_json::Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 2);
        assert!(
            responses
                .iter()
                .all(|response| response["ok"] == true && response["command"] == "version")
        );
    }

    #[test]
    fn incomplete_or_oversized_frames_never_dispatch() {
        for bytes in [
            b"[\"version\"]".to_vec(),
            vec![b'x'; MAX_REQUEST_BYTES as usize + 1],
        ] {
            let mut output = Vec::new();
            serve(std::io::Cursor::new(bytes), &mut output, |_| {
                panic!("must not dispatch")
            })
            .unwrap();
            let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
            assert_eq!(response["error"]["code"], "INVALID_ARGS");
            assert_eq!(
                response["error"]["disposition"]["delivery"],
                "not_delivered"
            );
        }
    }

    #[test]
    fn request_cannot_cross_session_namespace() {
        assert!(parse_request(b"[\"--session\",\"other\",\"version\"]", Some("owner")).is_err());
        assert!(parse_request(b"[\"--session\",\"owner\",\"version\"]", Some("owner")).is_ok());
        assert!(parse_request(b"[\"version\"]", Some("owner")).is_ok());
    }

    #[test]
    fn a_lost_reply_never_replays_the_command() {
        let mut attempts = 0;
        let error = serve(std::io::Cursor::new(b"[]\n[]\n"), RejectWrites, |_| {
            attempts += 1;
            Response::ok("click", serde_json::json!({}))
        })
        .unwrap_err();
        assert!(
            matches!(error, AppError::Io(error) if error.kind() == std::io::ErrorKind::BrokenPipe)
        );
        assert_eq!(attempts, 1);
    }

    #[test]
    fn a_frame_timeout_never_dispatches_or_reads_another_request() {
        let mut reads = 0;
        let error = serve_frames(
            || {
                reads += 1;
                Err(std::io::ErrorKind::TimedOut.into())
            },
            Vec::new(),
            |_| panic!("timed-out frame must not dispatch"),
        )
        .unwrap_err();
        let response = crate::response("host", Err(error));
        let response = serde_json::to_value(response).unwrap();
        assert_eq!(response["error"]["code"], "TIMEOUT");
        assert_eq!(
            response["error"]["disposition"]["delivery"],
            "not_delivered"
        );
        assert_eq!(reads, 1);
    }

    struct RejectWrites;

    impl Write for RejectWrites {
        fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
