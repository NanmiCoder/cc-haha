#[derive(Debug, Clone, Default)]
pub struct SignalFilter {
    pub app: Option<String>,
    pub process: Option<crate::ProcessIdentity>,
}
