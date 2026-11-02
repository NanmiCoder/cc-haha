use agent_desktop_core::{AppError, response::output::Response};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostRequest {
    pub identity: String,
    pub args: Vec<String>,
    pub directory: PathBuf,
    pub agent_id: Option<String>,
    pub expires_ns: u64,
    #[serde(default)]
    pub baseline: Option<agent_desktop_core::SignalBaseline>,
}

pub(super) fn execute(bytes: &[u8], identity: &str, session: Option<&str>) -> Response {
    match prepare(bytes, identity, session) {
        Ok((cli, command, deadline, baseline)) => crate::response(
            command.name(),
            crate::execute_with_deadline(cli, command, Some(deadline), baseline),
        ),
        Err(error) => crate::response("unknown", Err(crate::pre_dispatch_error(error))),
    }
}

fn prepare(
    bytes: &[u8],
    identity: &str,
    session: Option<&str>,
) -> Result<
    (
        crate::Cli,
        crate::Commands,
        agent_desktop_core::Deadline,
        Option<agent_desktop_core::SignalBaseline>,
    ),
    AppError,
> {
    let request: HostRequest = serde_json::from_slice(bytes)
        .map_err(|_| AppError::invalid_input("Invalid command host request envelope"))?;
    if request.identity != identity {
        return Err(AppError::invalid_input(
            "Command host identity does not match the caller",
        ));
    }
    if !request.directory.is_absolute() {
        return Err(AppError::invalid_input(
            "Command host working directory must be absolute",
        ));
    }
    let (mut cli, command) = super::parse_request(&serde_json::to_vec(&request.args)?, session)?;
    if cli.identity.agent_id.is_none() {
        cli.identity.agent_id = request.agent_id;
    }
    let deadline =
        agent_desktop_core::Deadline::from_duration(super::budget::remaining(request.expires_ns)?)?;
    std::env::set_current_dir(&request.directory)?;
    Ok((cli, command, deadline, request.baseline))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_identity_or_namespace_never_changes_the_working_directory() {
        let before = std::env::current_dir().unwrap();
        for (identity, args) in [
            ("another executable", vec!["version"]),
            ("owner", vec!["--session", "other", "version"]),
        ] {
            let bytes = serde_json::to_vec(&HostRequest {
                identity: identity.into(),
                args: args.into_iter().map(str::to_owned).collect(),
                directory: PathBuf::from("/"),
                agent_id: None,
                expires_ns: u64::MAX,
                baseline: None,
            })
            .unwrap();
            let response = execute(&bytes, "owner", Some("mine"));
            let response = serde_json::to_value(response).unwrap();
            assert_eq!(response["ok"], false);
            assert_eq!(
                response["error"]["disposition"]["delivery"],
                "not_delivered"
            );
            assert_eq!(std::env::current_dir().unwrap(), before);
        }
    }
}
