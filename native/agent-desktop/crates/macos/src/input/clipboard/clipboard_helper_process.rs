use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::clipboard_helper_identity::HelperIdentity;
use super::clipboard_helper_protocol as protocol;

const CLEANUP_RESERVE: Duration = Duration::from_millis(100);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

pub(crate) fn run(
    command: &mut Command,
    input: &[u8],
    deadline: Deadline,
    identity: Option<&HelperIdentity>,
) -> Result<Vec<u8>, AdapterError> {
    let absolute = Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::timeout("Clipboard helper deadline overflowed"))?;
    let work_deadline = absolute
        .checked_sub(CLEANUP_RESERVE)
        .filter(|limit| *limit > Instant::now())
        .ok_or_else(|| deadline.timeout_error())?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn().map_err(spawn_error)?;
    let process_group = i32::try_from(child.id()).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        AdapterError::internal("Clipboard helper PID exceeds the macOS pid_t range")
    })?;
    let Some(stdin) = child.stdin.take() else {
        return cleanup_bare(
            child,
            process_group,
            absolute,
            AdapterError::internal("Clipboard helper stdin is unavailable"),
        );
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        return cleanup_bare(
            child,
            process_group,
            absolute,
            AdapterError::internal("Clipboard helper output FD is unavailable"),
        );
    };
    let writer = spawn_writer(stdin, input.to_vec());
    let reader = spawn_reader(stdout);
    if let Some(identity) = identity
        && let Err(error) = identity.revalidate()
    {
        return cleanup(child, process_group, writer, reader, absolute, error);
    }
    let status = match wait_status(&mut child, work_deadline) {
        Ok(status) => status,
        Err(error) => return cleanup(child, process_group, writer, reader, absolute, error),
    };
    let write_result = receive(&writer, work_deadline, "writing request");
    let read_result = receive(&reader, work_deadline, "reading response");
    match (write_result, read_result) {
        (Ok(()), Ok(output)) => {
            join_thread(writer.1)?;
            join_thread(reader.1)?;
            if !status.success() && output.is_empty() {
                return Err(mark_dispatched(AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    format!("macOS clipboard helper exited with {status}"),
                )));
            }
            Ok(output)
        }
        (write, read) => cleanup(
            child,
            process_group,
            writer,
            reader,
            absolute,
            write
                .err()
                .or_else(|| read.err())
                .unwrap_or_else(|| AdapterError::internal("Clipboard helper I/O failed")),
        ),
    }
}

fn spawn_error(error: std::io::Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The packaged macOS clipboard helper could not be started",
    )
    .with_platform_detail(error.to_string())
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn wait_status(child: &mut Child, deadline: Instant) -> Result<ExitStatus, AdapterError> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => return Err(AdapterError::timeout("macOS clipboard helper timed out")),
            Err(error) => {
                return Err(AdapterError::internal(format!(
                    "Inspect macOS clipboard helper: {error}"
                )));
            }
        }
    }
}

type IoThread<T> = (
    mpsc::Receiver<std::io::Result<T>>,
    std::thread::JoinHandle<()>,
);

fn spawn_writer(mut stdin: impl Write + Send + 'static, input: Vec<u8>) -> IoThread<()> {
    spawn_io(move || stdin.write_all(&input))
}

fn spawn_reader(mut output: impl Read + Send + 'static) -> IoThread<Vec<u8>> {
    spawn_io(move || {
        let mut bytes = Vec::new();
        output
            .by_ref()
            .take((protocol::MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > protocol::MAX_RESPONSE_BYTES {
            return Err(std::io::Error::other(
                "clipboard helper response exceeds limit",
            ));
        }
        Ok(bytes)
    })
}

fn spawn_io<T: Send + 'static>(
    operation: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> IoThread<T> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    (receiver, thread)
}

fn receive<T>(thread: &IoThread<T>, deadline: Instant, phase: &str) -> Result<T, AdapterError> {
    thread
        .0
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| AdapterError::timeout(format!("Timed out {phase} for clipboard helper")))?
        .map_err(|error| AdapterError::internal(format!("Clipboard helper {phase}: {error}")))
}

fn cleanup(
    mut child: Child,
    process_group: i32,
    writer: IoThread<()>,
    reader: IoThread<Vec<u8>>,
    deadline: Instant,
    error: AdapterError,
) -> Result<Vec<u8>, AdapterError> {
    kill_and_reap(&mut child, process_group, deadline);
    finish_thread(writer, deadline);
    finish_thread(reader, deadline);
    Err(mark_dispatched(error))
}

fn cleanup_bare(
    mut child: Child,
    process_group: i32,
    deadline: Instant,
    error: AdapterError,
) -> Result<Vec<u8>, AdapterError> {
    kill_and_reap(&mut child, process_group, deadline);
    Err(mark_dispatched(error))
}

fn kill_and_reap(child: &mut Child, process_group: i32, deadline: Instant) {
    unsafe {
        libc::kill(-process_group, libc::SIGKILL);
    }
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn finish_thread<T>(thread: IoThread<T>, deadline: Instant) {
    if thread
        .0
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .is_ok()
    {
        let _ = thread.1.join();
    }
}

fn join_thread(thread: std::thread::JoinHandle<()>) -> Result<(), AdapterError> {
    thread.join().map_err(|_| {
        mark_dispatched(AdapterError::internal(
            "Clipboard helper I/O thread panicked",
        ))
    })
}

pub(crate) fn mark_dispatched(mut error: AdapterError) -> AdapterError {
    let mut details = error.details.take().unwrap_or_else(|| json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("helper_dispatched".into(), Value::Bool(true));
    }
    error.with_details(details)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_deadline_kills_the_helper_process_group() {
        let pgid_file = std::env::temp_dir().join(format!("ad-clip-pgid-{}", std::process::id()));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo $$ > \"$1\"; sleep 60 & wait", "sh"]);
        command.arg(&pgid_file);
        let error = run(&mut command, &[], Deadline::after(800).unwrap(), None).unwrap_err();

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["helper_dispatched"], true);
        let pgid: i32 = std::fs::read_to_string(&pgid_file)
            .expect("helper reported its process group")
            .trim()
            .parse()
            .expect("process group id");
        let _ = std::fs::remove_file(&pgid_file);
        let give_up = Instant::now() + Duration::from_secs(10);
        while group_has_live_member(pgid) && Instant::now() < give_up {
            std::thread::sleep(POLL_INTERVAL);
        }
        assert!(
            !group_has_live_member(pgid),
            "helper process group {pgid} survived the deadline"
        );
    }

    fn group_has_live_member(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }

    #[test]
    fn post_dispatch_thread_failure_is_never_unmarked() {
        let error = join_thread(std::thread::spawn(|| panic!("fault"))).unwrap_err();

        assert_eq!(error.details.unwrap()["helper_dispatched"], true);
    }
}
