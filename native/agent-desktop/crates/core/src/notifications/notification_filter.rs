#[derive(Debug, Clone, Default)]
pub struct NotificationFilter {
    pub app: Option<String>,
    pub text: Option<String>,
    pub limit: Option<usize>,
}

#[cfg(test)]
#[path = "notification_filter_tests.rs"]
mod tests;
