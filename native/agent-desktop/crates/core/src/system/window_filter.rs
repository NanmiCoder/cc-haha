#[derive(Debug, Clone, Default)]
pub struct WindowFilter {
    pub focused_only: bool,
    /// Exact application identity enforced by the platform adapter. Adapters
    /// may resolve this against display names, bundle identifiers, or PIDs.
    pub app: Option<String>,
}
