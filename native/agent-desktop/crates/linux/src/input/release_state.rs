use agent_desktop_core::{AdapterError, DeliverySemantics};

#[derive(Debug, Default)]
pub(crate) struct ReleaseState {
    armed: bool,
    delivered: u32,
    started: bool,
}

impl ReleaseState {
    pub(crate) fn resumed(delivered: u32, armed: bool) -> Self {
        Self {
            armed,
            delivered,
            started: delivered > 0,
        }
    }

    pub(crate) fn arm(&mut self) {
        self.armed = true;
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) fn mark_delivered(&mut self) {
        self.started = true;
        self.delivered = self.delivered.saturating_add(1);
    }

    pub(crate) fn mark_started(&mut self) {
        self.started = true;
    }

    pub(crate) fn delivered(&self) -> u32 {
        self.delivered
    }

    pub(crate) fn should_release(&self) -> bool {
        self.armed
    }

    pub(crate) fn enrich_error(&self, error: AdapterError, suggestion: &str) -> AdapterError {
        let started = self.started
            || error
                .details
                .as_ref()
                .is_some_and(|details| details["physical_delivery_started"] == true);
        if self.delivered == 0 && !started {
            return error.with_disposition(DeliverySemantics::not_delivered());
        }
        let mut details = error
            .details
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = details.as_object_mut() {
            map.insert("physical_delivery_started".into(), started.into());
            map.insert("delivered_events".into(), self.delivered.into());
            if self.armed {
                map.insert("emergency_release_posted".into(), true.into());
                map.insert("emergency_release_acknowledged".into(), false.into());
            }
        }
        error
            .with_disposition(if self.delivered == 0 {
                DeliverySemantics::uncertain()
            } else {
                DeliverySemantics::delivered_unverified()
            })
            .with_details(details)
            .with_suggestion(suggestion)
    }
}

#[cfg(test)]
#[path = "release_state_tests.rs"]
mod tests;
