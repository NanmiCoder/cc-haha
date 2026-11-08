use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use agent_desktop_core::system::launch_options::LaunchOptions;
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::launch_observe::Spawned;
use super::launch_target::Plan;

pub(super) fn before_spawn(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn invalid(message: &str) -> AdapterError {
    before_spawn(AdapterError::new(ErrorCode::InvalidArgs, message))
}

pub(super) fn validate(options: &LaunchOptions) -> Result<(), AdapterError> {
    if options.args.iter().any(|arg| arg.contains('\0')) {
        return Err(invalid("A launch argument holds a NUL"));
    }
    let bad_env = options
        .env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'));
    if bad_env {
        return Err(invalid(
            "A launch environment entry has an invalid name or value",
        ));
    }
    if options.cwd.as_ref().is_some_and(|dir| !dir.is_dir()) {
        return Err(invalid("The launch working directory is not a directory"));
    }
    Ok(())
}

fn spawn_error(identifier: &str, error: &std::io::Error) -> AdapterError {
    let (code, message) = match error.kind() {
        std::io::ErrorKind::NotFound => (
            ErrorCode::AppNotFound,
            format!("'{identifier}' could not be started: the program was not found"),
        ),
        std::io::ErrorKind::PermissionDenied => (
            ErrorCode::ActionFailed,
            format!("'{identifier}' could not be started: the program is not executable"),
        ),
        kind => (
            ErrorCode::ActionFailed,
            format!("'{identifier}' could not be started ({kind})"),
        ),
    };
    let mut refusal = before_spawn(AdapterError::new(code, message));
    if let Some(errno) = error.raw_os_error() {
        refusal = refusal.with_platform_detail(format!("errno {errno}"));
    }
    refusal
}

pub(super) fn spawn(
    identifier: &str,
    plan: &Plan,
    options: &LaunchOptions,
) -> Result<Spawned, AdapterError> {
    let (program, arguments) = plan
        .argv
        .split_first()
        .ok_or_else(|| invalid("The launch command is empty"))?;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .envs(&options.env)
        .env(crate::system::process::session_origin::LAUNCH_MARKER, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let directory = options
        .cwd
        .as_ref()
        .or(plan.cwd.as_ref().filter(|dir| dir.is_dir()));
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    command
        .spawn()
        .map(|child| Spawned::new(child, identifier))
        .map_err(|error| spawn_error(identifier, &error))
}
