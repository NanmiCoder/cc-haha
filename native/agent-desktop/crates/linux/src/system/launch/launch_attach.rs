use crate::system::process::running_app::Running;
/// What a launch does about the applications already running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decision {
    Spawn,
    Attach(Running),
    Forward,
    Refuse(Vec<u32>),
    Ambiguous(Vec<u32>),
}

/// Only verified canonical executable identity can establish attachment.
pub(crate) fn matches(
    identity: &Option<crate::system::process::executable_identity::ExecutableIdentity>,
    app: &Running,
) -> bool {
    identity
        .as_ref()
        .zip(app.executable.as_ref())
        .is_some_and(|(wanted, actual)| wanted.matches(actual))
}

/// Decides before anything is spawned. No match spawns. One match is attached
/// to, and spawns only when arguments have to reach it, in which case the
/// spawned process forwards them or starts a second instance. With
/// `attach_if_running` false, any match refuses; otherwise several matches
/// are ambiguous.
pub(crate) fn decide(
    identity: &Option<crate::system::process::executable_identity::ExecutableIdentity>,
    running: &[Running],
    attach_if_running: bool,
    has_arguments: bool,
) -> Decision {
    let found: Vec<&Running> = running
        .iter()
        .filter(|app| matches(identity, app))
        .collect();
    let pids = || found.iter().map(|app| app.pid).collect::<Vec<_>>();
    match found.as_slice() {
        [] => Decision::Spawn,
        _ if !attach_if_running => Decision::Refuse(pids()),
        [_] if has_arguments => Decision::Forward,
        [one] => Decision::Attach((*one).clone()),
        _ => Decision::Ambiguous(pids()),
    }
}

#[cfg(test)]
#[path = "launch_attach_tests.rs"]
mod tests;
