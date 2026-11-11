/// A running application as the registry lists it, once per process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Running {
    pub(crate) executable: Option<super::executable_identity::ExecutableIdentity>,
    pub(crate) pid: u32,
    pub(crate) instance: String,
    pub(crate) name: String,
}

impl Running {
    pub(crate) fn identity(&self) -> agent_desktop_core::ProcessIdentity {
        agent_desktop_core::ProcessIdentity::new(self.pid, self.instance.clone())
    }
}
