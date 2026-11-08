use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

const TAIL_BYTES: u64 = 8 * 1024;
const TAIL_LINES: usize = 20;
const EXIT_CODE_AFTER_STATE: usize = 48;

#[derive(Debug, PartialEq)]
enum ProcessState {
    Running,
    Exited(Option<ExitStatus>),
    Gone,
}

/// Where the stderr of a launched process is kept. The name is the pid, so a
/// waiter that holds only the pid finds it.
pub(crate) fn stderr_path(pid: u32) -> PathBuf {
    std::env::temp_dir().join(format!("ad-live-stderr-{pid}.log"))
}

/// True while the process has not exited. A child that exited and was not
/// waited for is a zombie whose `/proc` entry still exists, so that entry
/// alone does not tell.
pub(crate) fn is_running(pid: u32) -> bool {
    state_of(pid) == ProcessState::Running
}

/// What a failure message says about a launched process: whether it runs, how
/// it exited, and the last lines it wrote to stderr.
pub(crate) fn process_report(pid: u32) -> String {
    let state = match state_of(pid) {
        ProcessState::Running => "is running".to_owned(),
        ProcessState::Exited(Some(status)) => format!("exited, {status}"),
        ProcessState::Exited(None) => "exited".to_owned(),
        ProcessState::Gone => "is gone".to_owned(),
    };
    match tail_of(&stderr_path(pid)) {
        Some(tail) if !tail.is_empty() => {
            format!("process {pid} {state}; its stderr ends:\n{tail}")
        }
        Some(_) => format!("process {pid} {state}; its stderr is empty"),
        None => format!("process {pid} {state}; no stderr was captured"),
    }
}

fn state_of(pid: u32) -> ProcessState {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_or(ProcessState::Gone, |line| parse_state(&line))
}

/// Reads the state from a `/proc/<pid>/stat` line. The command name sits in
/// parentheses and may hold spaces and parentheses itself, so the fields start
/// after the last `)`. A zombie keeps its wait status in the line.
fn parse_state(line: &str) -> ProcessState {
    let Some((_, fields)) = line.rsplit_once(')') else {
        return ProcessState::Gone;
    };
    let mut fields = fields.split_whitespace();
    match fields.next() {
        Some("Z" | "X" | "x") => ProcessState::Exited(
            fields
                .nth(EXIT_CODE_AFTER_STATE)
                .and_then(|status| status.parse().ok())
                .map(ExitStatus::from_raw),
        ),
        Some(_) => ProcessState::Running,
        None => ProcessState::Gone,
    }
}

/// The last lines of a log, read from its last bytes so a process that writes
/// megabytes never puts them in a failure message.
fn tail_of(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    Some(lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n"))
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    use super::{ProcessState, TAIL_LINES, parse_state, tail_of};
    use crate::tree::live::live_launch::nonce;

    fn zombie_line(command: &str, wait_status: i32) -> String {
        format!("7 ({command}) Z {}{wait_status}\n", "0 ".repeat(48))
    }

    #[test]
    fn a_zombie_line_gives_the_status_it_exited_with() {
        assert_eq!(
            parse_state(&zombie_line("sh", 768)),
            ProcessState::Exited(Some(ExitStatus::from_raw(768)))
        );
        assert_eq!(
            parse_state(&zombie_line("sleep", 9)),
            ProcessState::Exited(Some(ExitStatus::from_raw(9)))
        );
    }

    #[test]
    fn the_state_is_the_field_after_the_last_parenthesis() {
        let cases = [
            (
                "a running process",
                "1 (init) S 0 1 1 0 -1 4194560\n".to_owned(),
                ProcessState::Running,
            ),
            (
                "a running process whose name holds a space and parentheses",
                "42 (we ) ird Z) S 1 42 42\n".to_owned(),
                ProcessState::Running,
            ),
            (
                "a zombie whose name ends like a running state",
                zombie_line("a) S", 256),
                ProcessState::Exited(Some(ExitStatus::from_raw(256))),
            ),
            (
                "a zombie line without the exit code field",
                "7 (x) Z 1 7 7\n".to_owned(),
                ProcessState::Exited(None),
            ),
            ("an empty entry", String::new(), ProcessState::Gone),
            (
                "an entry without a command name",
                "garbage".to_owned(),
                ProcessState::Gone,
            ),
        ];
        for (label, line, expected) in cases {
            assert_eq!(parse_state(&line), expected, "{label}");
        }
    }

    #[test]
    fn the_tail_of_a_long_log_is_its_last_lines_and_not_the_whole_file() {
        let path = std::env::temp_dir().join(nonce("tail"));
        let text: String = (1..=5000)
            .map(|number| format!("line {number}\n"))
            .collect();
        std::fs::write(&path, &text).expect("the log is written");
        let tail = tail_of(&path).expect("the log reads");
        std::fs::remove_file(&path).expect("the log is removed");
        let lines: Vec<&str> = tail.lines().collect();
        assert_eq!(lines.len(), TAIL_LINES);
        assert_eq!(lines.first(), Some(&"line 4981"));
        assert_eq!(lines.last(), Some(&"line 5000"));
    }
}
