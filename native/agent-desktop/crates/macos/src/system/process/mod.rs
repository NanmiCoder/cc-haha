use agent_desktop_core::{AdapterError, ErrorCode};
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAX_CAPTURED_STREAM_BYTES: usize = 8 * 1024 * 1024;
const OUTPUT_CONTEXT_BYTES: usize = 4 * 1024;
const MAX_CLEANUP_RESERVE: Duration = Duration::from_millis(250);
const TERM_GRACE: Duration = Duration::from_millis(25);
const POSIX_EPERM: i32 = 1;
const POSIX_ESRCH: i32 = 3;

struct DrainResult {
    bytes: Vec<u8>,
    tail: Vec<u8>,
    exceeded_limit: bool,
}

type DrainHandle = (mpsc::Receiver<std::io::Result<DrainResult>>, JoinHandle<()>);

#[cfg(test)]
pub(crate) fn run_with_timeout(
    command: &mut Command,
    label: &str,
    timeout: Duration,
) -> Result<Output, AdapterError> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        AdapterError::timeout(format!("{label} timeout exceeds the supported range"))
    })?;
    run_with_deadline(command, label, deadline)
}

pub(crate) fn run_with_deadline(
    command: &mut Command,
    label: &str,
    deadline: Instant,
) -> Result<Output, AdapterError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AdapterError::timeout(format!(
            "{label} has no subprocess cleanup budget"
        )));
    }
    let cleanup_reserve = (remaining / 4).min(MAX_CLEANUP_RESERVE);
    let work_deadline = deadline.checked_sub(cleanup_reserve).ok_or_else(|| {
        AdapterError::timeout(format!("{label} has no subprocess cleanup budget"))
    })?;
    configure_process_group(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AdapterError::internal(format!("{label}: {error}")))?;
    let process_group = i32::try_from(child.id()).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        AdapterError::internal(format!("{label}: child PID exceeds the macOS pid_t range"))
    })?;
    let mut stdout = child.stdout.take().map(spawn_drain);
    let mut stderr = child.stderr.take().map(spawn_drain);

    let stderr_result = match receive_drain(&mut stderr, label, "stderr", work_deadline) {
        Ok(result) => result,
        Err(error) => {
            return cleanup_after_error(
                &mut child,
                process_group,
                &mut stdout,
                &mut stderr,
                label,
                deadline,
                error,
            );
        }
    };
    let stdout_result = match receive_drain(&mut stdout, label, "stdout", work_deadline) {
        Ok(result) => result,
        Err(error) => {
            return cleanup_after_error(
                &mut child,
                process_group,
                &mut stdout,
                &mut stderr,
                label,
                deadline,
                error,
            );
        }
    };
    let status = match wait_for_status(&mut child, work_deadline) {
        Ok(status) => status,
        Err(error) => {
            return cleanup_after_error(
                &mut child,
                process_group,
                &mut stdout,
                &mut stderr,
                label,
                deadline,
                error,
            );
        }
    };
    if stdout_result.exceeded_limit || stderr_result.exceeded_limit {
        return Err(output_limit_error(label, &stdout_result, &stderr_result));
    }
    Ok(Output {
        status,
        stdout: stdout_result.bytes,
        stderr: stderr_result.bytes,
    })
}

fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

fn wait_for_status(child: &mut Child, deadline: Instant) -> Result<ExitStatus, AdapterError> {
    loop {
        if Instant::now() >= deadline {
            return Err(AdapterError::timeout(
                "Subprocess exceeded its work deadline",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => std::thread::sleep(poll_interval(deadline)),
            Err(error) => {
                return Err(AdapterError::internal(format!(
                    "Could not inspect subprocess status: {error}"
                )));
            }
        }
    }
}

fn cleanup_after_error(
    child: &mut Child,
    process_group: i32,
    stdout: &mut Option<DrainHandle>,
    stderr: &mut Option<DrainHandle>,
    label: &str,
    deadline: Instant,
    mut original: AdapterError,
) -> Result<Output, AdapterError> {
    let cleanup_failures = terminate_process_group(child, process_group, deadline);
    let _ = receive_drain(stderr, label, "stderr", deadline);
    let _ = receive_drain(stdout, label, "stdout", deadline);
    if !cleanup_failures.is_empty() {
        original = original.with_platform_detail(cleanup_failures.join("; "));
    }
    Err(original)
}

fn terminate_process_group(
    child: &mut Child,
    process_group: i32,
    deadline: Instant,
) -> Vec<String> {
    terminate_process_group_with(child, process_group, deadline, signal_group)
}

fn terminate_process_group_with(
    child: &mut Child,
    process_group: i32,
    deadline: Instant,
    mut signal: impl FnMut(i32, i32) -> std::io::Result<bool>,
) -> Vec<String> {
    let mut failures = Vec::new();
    if let Err(error) = signal(process_group, 15) {
        failures.push(format!("SIGTERM process group {process_group}: {error}"));
    }
    let grace_deadline = Instant::now()
        .checked_add(TERM_GRACE)
        .map_or(deadline, |grace| grace.min(deadline));
    std::thread::sleep(grace_deadline.saturating_duration_since(Instant::now()));
    let kill_error = signal(process_group, 9).err();
    let reaped = poll_reap(child, deadline);
    if let Some(error) = kill_error {
        let group_is_gone = reaped
            && error.raw_os_error() == Some(POSIX_EPERM)
            && matches!(signal(process_group, 0), Ok(false));
        if !group_is_gone {
            failures.push(format!("SIGKILL process group {process_group}: {error}"));
        }
    }
    if !reaped {
        failures.push("subprocess could not be reaped before cleanup deadline".into());
    }
    failures
}

fn signal_group(process_group: i32, signal: i32) -> std::io::Result<bool> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if unsafe { kill(-process_group, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(POSIX_ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}

pub(super) fn poll_reap(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(poll_interval(deadline));
            }
            Ok(None) | Err(_) => return false,
        }
    }
}

fn poll_interval(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_millis(20))
}

fn spawn_drain<R>(mut reader: R) -> DrainHandle
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut tail = Vec::new();
        let mut exceeded_limit = false;
        let mut chunk = [0_u8; 8192];
        let result = loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    break Ok(DrainResult {
                        bytes,
                        tail,
                        exceeded_limit,
                    });
                }
                Ok(count) => {
                    let remaining = MAX_CAPTURED_STREAM_BYTES.saturating_sub(bytes.len());
                    let retained = remaining.min(count);
                    bytes.extend_from_slice(&chunk[..retained]);
                    append_tail(&mut tail, &chunk[..count]);
                    exceeded_limit |= retained < count;
                }
                Err(error) => break Err(error),
            }
        };
        let _ = sender.send(result);
    });
    (receiver, thread)
}

fn receive_drain(
    handle: &mut Option<DrainHandle>,
    label: &str,
    stream: &str,
    deadline: Instant,
) -> Result<DrainResult, AdapterError> {
    let (receiver, _) = handle
        .as_ref()
        .ok_or_else(|| AdapterError::internal(format!("{label}: missing {stream}")))?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AdapterError::timeout(format!(
            "{label}: timed out draining {stream}"
        )));
    }
    let drained = receiver
        .recv_timeout(remaining)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => {
                AdapterError::timeout(format!("{label}: timed out draining {stream}"))
            }
            mpsc::RecvTimeoutError::Disconnected => {
                AdapterError::internal(format!("{label}: {stream} reader stopped unexpectedly"))
            }
        })?;
    let (_, thread) = handle
        .take()
        .ok_or_else(|| AdapterError::internal(format!("{label}: lost {stream} drain thread")))?;
    thread
        .join()
        .map_err(|_| AdapterError::internal(format!("{label}: {stream} drain thread panicked")))?;
    drained.map_err(|error| AdapterError::internal(format!("{label}: read {stream}: {error}")))
}

fn append_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= OUTPUT_CONTEXT_BYTES {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - OUTPUT_CONTEXT_BYTES..]);
        return;
    }
    let overflow = tail
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(OUTPUT_CONTEXT_BYTES);
    if overflow > 0 {
        tail.drain(..overflow);
    }
    tail.extend_from_slice(chunk);
}

fn output_limit_error(label: &str, stdout: &DrainResult, stderr: &DrainResult) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("{label}: subprocess output exceeded the capture limit"),
    )
    .with_details(serde_json::json!({
        "kind": "subprocess_output_limit",
        "limit_bytes": MAX_CAPTURED_STREAM_BYTES,
        "stderr_exceeded": stderr.exceeded_limit,
        "stderr_tail": String::from_utf8_lossy(&stderr.tail),
        "stdout_exceeded": stdout.exceeded_limit,
        "stdout_tail": String::from_utf8_lossy(&stdout.tail),
    }))
}

pub(crate) mod process_apps;
pub(crate) mod process_identity;
pub(crate) mod process_state;
#[cfg(all(test, unix))]
#[path = "process_tests.rs"]
mod tests;
