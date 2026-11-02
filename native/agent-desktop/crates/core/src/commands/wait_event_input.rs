pub(crate) struct EventWaitInput {
    pub event: String,
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub window_title: Option<String>,
    pub timeout_ms: u64,
}
