#[derive(Debug, Clone)]
pub struct WaitSelector {
    pub query_raw: String,
    pub gone: bool,
    pub timeout_ms: u64,
}
