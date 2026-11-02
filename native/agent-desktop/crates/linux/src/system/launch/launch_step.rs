use crate::system::process::running_app::Running;
use std::process::ExitStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    Wait,
    Owner(Running),
    Ambiguous(Vec<u32>),
    Failed(ExitStatus),
}
