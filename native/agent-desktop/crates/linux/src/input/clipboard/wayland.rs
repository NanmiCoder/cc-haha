use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
    InteractionLease,
};

use super::command_runner::{CommandRunner, RunOutcome, RunSpec};
use super::delivery::{fresh_deadline, not_delivered, unresponsive};
use super::formats::{PNG, TEXT_UTF8, URI_LIST};
use super::owner::owner_spawn_spec::protect_lease_descriptor;
use super::payload::payload_of;
use super::targets::{choose_target, content_of};
use super::wayland_errors::{Failure, classify, failure_error};

const COPY: &str = "wl-copy";
const PASTE: &str = "wl-paste";

pub(crate) struct Wayland<'a> {
    pub(crate) runner: &'a dyn CommandRunner,
    pub(crate) search_path: Option<OsString>,
}

fn missing_tool(name: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        format!("{name} was not found, so the Wayland clipboard cannot be used"),
    )
    .with_suggestion("Install the wl-clipboard package, then try again")
    .with_disposition(DeliverySemantics::not_delivered())
}

fn executable(candidate: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    candidate
        .metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The absolute path of `name` in the absolute entries of `search_path`.
/// A relative entry is skipped so the working directory never supplies a tool.
pub(crate) fn locate(name: &str, search_path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(search_path?)
        .filter(|entry| entry.is_absolute())
        .map(|entry| entry.join(name))
        .find(|candidate| executable(candidate))
}

fn timed_out(delivery: DeliverySemantics) -> AdapterError {
    crate::system::display::display_server::display_cause_error(
        &crate::system::display::display_server::DisplayCause::Silent,
    )
    .with_disposition(delivery)
}

fn not_started(reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The Wayland clipboard tool could not start",
    )
    .with_platform_detail(reason)
    .with_disposition(DeliverySemantics::not_delivered())
}

fn over_cap() -> AdapterError {
    not_delivered(AdapterError::new(
        ErrorCode::ActionFailed,
        "The clipboard holds more than the size cap",
    ))
}

enum Ran {
    Done(Vec<u8>),
    Failed(Failure),
}

impl Wayland<'_> {
    fn tool(&self, name: &str) -> Result<PathBuf, AdapterError> {
        locate(name, self.search_path.as_deref()).ok_or_else(|| missing_tool(name))
    }

    fn run(
        &self,
        spec: &RunSpec,
        deadline: Deadline,
        unknown: DeliverySemantics,
    ) -> Result<Ran, AdapterError> {
        match self.runner.run(spec, deadline) {
            RunOutcome::Exited {
                code: Some(0),
                stdout,
                ..
            } => Ok(Ran::Done(stdout)),
            RunOutcome::Exited {
                code: Some(_),
                stderr,
                ..
            } => Ok(Ran::Failed(classify(&stderr))),
            RunOutcome::Exited { code: None, .. } => Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "The Wayland clipboard tool was stopped by a signal",
            )
            .with_disposition(unknown)),
            RunOutcome::TimedOut => Err(timed_out(unknown)),
            RunOutcome::OverCap => Err(over_cap()),
            RunOutcome::NotStarted(reason) => Err(not_started(&reason)),
        }
    }

    fn list_types(&self, deadline: Deadline) -> Result<Option<Vec<String>>, AdapterError> {
        let spec = RunSpec {
            program: self.tool(PASTE)?,
            args: vec!["--list-types".into()],
            stdin: None,
            capture_stdout: true,
        };
        match self.run(&spec, deadline, DeliverySemantics::not_delivered())? {
            Ran::Done(stdout) => Ok(Some(
                String::from_utf8_lossy(&stdout)
                    .lines()
                    .map(str::to_owned)
                    .collect(),
            )),
            Ran::Failed(Failure::Empty) => Ok(None),
            Ran::Failed(failure) => {
                Err(failure_error(&failure, DeliverySemantics::not_delivered()))
            }
        }
    }

    pub(crate) fn read(
        &self,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        let Some(offered) = self.list_types(deadline)? else {
            return Ok(None);
        };
        let Some(wanted) = choose_target(&offered, format) else {
            return Ok(None);
        };
        let spec = RunSpec {
            program: self.tool(PASTE)?,
            args: vec![
                "--no-newline".into(),
                "--type".into(),
                wanted.target_name().into(),
            ],
            stdin: None,
            capture_stdout: true,
        };
        let bytes = match self.run(&spec, deadline, DeliverySemantics::not_delivered())? {
            Ran::Done(bytes) => bytes,
            Ran::Failed(Failure::Empty | Failure::TypeUnavailable) => return Ok(None),
            Ran::Failed(failure) => {
                return Err(failure_error(&failure, DeliverySemantics::not_delivered()));
            }
        };
        match content_of(&wanted, bytes).map_err(not_delivered)? {
            ClipboardContent::FileUrls(paths) if paths.is_empty() => Ok(None),
            content => Ok(Some(content)),
        }
    }

    fn mime_and_bytes(content: &ClipboardContent) -> Result<(&'static str, Vec<u8>), AdapterError> {
        let mime = match content {
            ClipboardContent::Text(_) => TEXT_UTF8,
            ClipboardContent::Image(_) => PNG,
            ClipboardContent::FileUrls(_) => URI_LIST,
        };
        let payload = payload_of(content).map_err(not_delivered)?;
        let target = payload
            .targets
            .into_iter()
            .find(|target| target.name == mime)
            .ok_or_else(|| AdapterError::internal("The clipboard payload lacks its main type"))?;
        Ok((mime, target.bytes))
    }

    fn write(
        &self,
        args: Vec<String>,
        stdin: Option<Vec<u8>>,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let spec = RunSpec {
            program: self.tool(COPY)?,
            args,
            stdin,
            capture_stdout: false,
        };
        protect_lease_descriptor(&|name| std::env::var(name).ok());
        match self.run(&spec, deadline, DeliverySemantics::uncertain())? {
            Ran::Done(_) => Ok(()),
            Ran::Failed(failure) => Err(failure_error(&failure, DeliverySemantics::uncertain())),
        }
    }

    pub(crate) fn set(
        &self,
        content: &ClipboardContent,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        let deadline = lease.deadline();
        let (mime, bytes) = Self::mime_and_bytes(content)?;
        self.tool(COPY)?;
        self.tool(PASTE)?;
        self.write(vec!["--type".into(), mime.into()], Some(bytes), deadline)?;
        match self.list_types(fresh_deadline(deadline)) {
            Ok(Some(offered)) if offered.iter().any(|name| name == mime) => Ok(()),
            _ => Err(unresponsive(
                "The Wayland clipboard was not seen holding the new content",
            )),
        }
    }

    pub(crate) fn clear(&self, lease: &InteractionLease) -> Result<(), AdapterError> {
        let deadline = lease.deadline();
        self.tool(PASTE)?;
        self.write(vec!["--clear".into()], None, deadline)?;
        match self.list_types(fresh_deadline(deadline)) {
            Ok(None) => Ok(()),
            _ => Err(unresponsive(
                "The Wayland clipboard was not seen empty after the clear",
            )),
        }
    }
}

#[cfg(test)]
#[path = "wayland_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wayland_live_tests.rs"]
mod live_tests;
