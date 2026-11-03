use crate::system::launch::launch_search::Search;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::desktop_entry::{DesktopEntry, parse};
use super::desktop_exec::{ExecContext, expand, program_word};
use super::desktop_lookup::{find, is_trusted};
use crate::system::app::app_alias::AliasIndex;
use crate::system::process::executable_identity::ExecutableIdentity;

/// The program to run, its arguments and the facts attach decisions read.
pub(crate) struct Plan {
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) identity: Option<ExecutableIdentity>,
}

fn refuse(code: ErrorCode, message: String) -> AdapterError {
    AdapterError::new(code, message).with_disposition(DeliverySemantics::not_delivered())
}

fn not_found(identifier: &str) -> AdapterError {
    refuse(
        ErrorCode::AppNotFound,
        format!("'{identifier}' is not an executable, a desktop id or a desktop entry name"),
    )
    .with_suggestion("Run 'list-apps' for running applications, or pass an absolute path.")
}

fn invalid(message: String) -> AdapterError {
    refuse(ErrorCode::InvalidArgs, message)
}

fn is_executable(file: &Path) -> bool {
    std::fs::metadata(file)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The first executable file with this name under the directories.
pub(crate) fn find_on_path(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|file| is_executable(file))
}

/// Whether the entry can be started: it must be a visible application with a
/// command that needs no terminal, and its `TryExec` must exist.
pub(crate) fn check_entry(entry: &DesktopEntry, path_dirs: &[PathBuf]) -> Result<(), AdapterError> {
    let id = &entry.id;
    if !entry.traits.application || entry.traits.hidden {
        return Err(refuse(
            ErrorCode::AppNotFound,
            format!("Desktop entry '{id}' is hidden or is not an application"),
        ));
    }
    if entry.traits.terminal || entry.exec.is_none() {
        return Err(refuse(
            ErrorCode::ActionNotSupported,
            format!("Desktop entry '{id}' needs a terminal or has no Exec and cannot be launched"),
        ));
    }
    let missing = entry.try_exec.as_deref().is_some_and(|program| {
        if program.starts_with('/') {
            !is_executable(Path::new(program))
        } else {
            find_on_path(program, path_dirs).is_none()
        }
    });
    if missing {
        return Err(refuse(
            ErrorCode::AppNotFound,
            format!("The program of desktop entry '{id}' is not installed"),
        ));
    }
    Ok(())
}

fn resolve_program(program: &str, path_dirs: &[PathBuf]) -> Result<String, AdapterError> {
    if program.contains('/') {
        return Ok(program.to_owned());
    }
    find_on_path(program, path_dirs)
        .map(|file| file.to_string_lossy().into_owned())
        .ok_or_else(|| {
            refuse(
                ErrorCode::AppNotFound,
                format!("The program '{program}' is not on PATH"),
            )
        })
}

fn entry_plan(id: &str, arguments: &[String], search: &Search) -> Result<Plan, AdapterError> {
    let file = find(id, &search.data_dirs).ok_or_else(|| not_found(id))?;
    plan_file(&file, id, arguments, search)
}

fn plan_file(
    file: &Path,
    id: &str,
    arguments: &[String],
    search: &Search,
) -> Result<Plan, AdapterError> {
    let text = std::fs::read_to_string(file).map_err(|_| not_found(id))?;
    let entry = parse(id, &text).ok_or_else(|| {
        refuse(
            ErrorCode::AppNotFound,
            format!("Desktop file of '{id}' has no [Desktop Entry] group"),
        )
    })?;
    check_entry(&entry, &search.path_dirs)?;
    let exec = entry.exec.as_deref().unwrap_or_default();
    let program = program_word(exec).ok_or_else(|| {
        refuse(
            ErrorCode::ActionNotSupported,
            format!("Desktop entry '{id}' has an empty Exec"),
        )
    })?;
    let file_text = file.to_string_lossy();
    let mut argv = expand(
        exec,
        &ExecContext {
            arguments,
            icon: entry.icon.as_deref(),
            name: &entry.name,
            file: Some(&file_text),
        },
    );
    let at = argv.iter().position(|word| *word == program).unwrap_or(0);
    argv[at] = resolve_program(&program, &search.path_dirs)?;
    argv[0] = resolve_program(&argv[0], &search.path_dirs)?;
    let identity = ExecutableIdentity::requested(&argv, &search.path_dirs);
    Ok(Plan {
        argv,
        cwd: entry.path.map(PathBuf::from),
        identity,
    })
}

fn direct_plan(program: String, arguments: &[String]) -> Plan {
    let argv: Vec<String> = std::iter::once(program)
        .chain(arguments.iter().cloned())
        .collect();
    let identity = ExecutableIdentity::requested(&argv, &[]);
    Plan {
        argv,
        cwd: None,
        identity,
    }
}

/// Resolve an identifier directly to the command and executable identity to launch.
/// The order is: absolute path, relative path refusal, installed desktop id,
/// executable on `PATH`, then an exact case-insensitive desktop `Name`.
pub(crate) fn resolve(
    identifier: &str,
    arguments: &[String],
    search: &Search,
    index: &AliasIndex,
) -> Result<Plan, AdapterError> {
    if identifier.trim().is_empty() || identifier.contains('\0') {
        return Err(invalid(
            "The launch identifier is empty or holds a NUL".to_owned(),
        ));
    }
    if identifier.starts_with('/') {
        let file = PathBuf::from(identifier);
        if let Some(id) = file
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".desktop"))
        {
            if !is_trusted(&file, &search.data_dirs) {
                return Err(invalid(format!(
                    "'{identifier}' is a desktop file outside the XDG data directories and is not launched"
                )));
            }
            return plan_file(&file, id, arguments, search);
        }
        if file.is_file() {
            return Ok(direct_plan(identifier.to_owned(), arguments));
        }
        return Err(not_found(identifier));
    }
    if identifier.contains('/') {
        return Err(invalid(format!(
            "'{identifier}' is a relative path; pass an absolute path, a command name or a desktop id"
        )));
    }
    if let Some(file) = find(identifier, &search.data_dirs) {
        let id = file.file_stem().and_then(|stem| stem.to_str());
        return entry_plan(id.unwrap_or(identifier), arguments, search);
    }
    if find_on_path(identifier, &search.path_dirs).is_some() {
        let program = resolve_program(identifier, &search.path_dirs)?;
        return Ok(direct_plan(program, arguments));
    }
    let mut ids = index.ids_named(identifier);
    match ids.len() {
        0 => Err(not_found(identifier)),
        1 => entry_plan(&ids.remove(0), arguments, search),
        _ => Err(AdapterError::ambiguous_target(format!(
            "'{identifier}' is the name of several desktop entries: {}",
            ids.join(", ")
        ))
        .with_disposition(DeliverySemantics::not_delivered())),
    }
}

#[cfg(test)]
#[path = "launch_target_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "launch_identity_tests.rs"]
mod identity_tests;
