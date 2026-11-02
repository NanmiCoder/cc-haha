use crate::NotificationInfo;

#[derive(Debug, Clone, Default)]
pub struct NotificationIdentity {
    pub expected_app: Option<String>,
    pub expected_title: Option<String>,
}

impl NotificationIdentity {
    pub fn is_empty(&self) -> bool {
        self.expected_app.as_deref().is_none_or(str::is_empty)
            && self.expected_title.as_deref().is_none_or(str::is_empty)
    }

    pub fn matches(&self, info: &NotificationInfo) -> bool {
        self.expected_app
            .as_ref()
            .is_none_or(|expected| expected == &info.app_name)
            && self
                .expected_title
                .as_ref()
                .is_none_or(|expected| expected == &info.title)
    }
}

#[cfg(test)]
#[path = "notification_identity_tests.rs"]
mod tests;
