//! Shared child-process spawn-and-await-stdout-handshake plumbing.
//!
//! Every fixture that hosts its window in a re-executed child process starts
//! the same way: spawn this same binary against one `--exact` test, capture
//! its stdout, run a reader thread over it, and block for whatever that
//! thread reports. What the reader thread actually does with each line - and
//! whether it exits once it has an answer or keeps running for the fixture's
//! whole life - is the caller's business; this only owns the process and the
//! timeout around it.

use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::thread::{JoinHandle, spawn};
use std::time::Duration;

const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Kills and waits for a child, discarding either failure - every caller is
/// already reporting an error or tearing down and has nothing further to do
/// with them.
pub(crate) fn kill_and_wait(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawns `command` with its stdout piped and stderr discarded, hands that
/// stdout to `reader` on a background thread, and blocks for the first value
/// that thread reports.
///
/// `reader` owns the handshake: it reads whatever it needs from the child's
/// stdout and sends `Some(value)` once it has one, or `None` at end of
/// stream. Whether it then returns or keeps monitoring the stdout for the
/// fixture's whole life is entirely up to it - this only waits for the first
/// message, and hands the reader thread's `JoinHandle` back so a caller that
/// keeps its reader running can join it later. `accept` rejects a value that
/// parsed but is not actually usable - a zero window handle from a line that
/// matched the prefix but failed to parse, say - so a bad report fails the
/// spawn exactly as a missing one would. On any failure the child is killed
/// and waited before `not_ready` is returned.
pub(crate) fn spawn_host<T: Send + 'static>(
    mut command: Command,
    reader: impl FnOnce(ChildStdout, Sender<Option<T>>) + Send + 'static,
    accept: fn(&T) -> bool,
    no_stdout: &str,
    not_ready: &str,
) -> Result<(Child, T, JoinHandle<()>), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| String::from(no_stdout))?;
    let (sender, receiver) = channel();
    let reader = spawn(move || reader(stdout, sender));
    match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Some(value)) if accept(&value) => Ok((child, value, reader)),
        _ => {
            kill_and_wait(&mut child);
            Err(String::from(not_ready))
        }
    }
}

/// Builds a one-shot reader body: reads lines until `classify` accepts one,
/// sends its value and returns; sends `None` if the stream ends first.
///
/// Covers every fixture whose handshake is the whole job - the child reports
/// its handle on one line and the reader thread has nothing left to do.
pub(crate) fn first_line<T: Send + 'static>(
    mut classify: impl FnMut(&str) -> Option<T> + Send + 'static,
) -> impl FnOnce(ChildStdout, Sender<Option<T>>) + Send + 'static {
    move |stdout, sender| {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if let Some(value) = classify(line.trim()) {
                let _ = sender.send(Some(value));
                return;
            }
        }
        let _ = sender.send(None);
    }
}
