use agent_desktop_core::AdapterError;

#[derive(Default)]
pub(crate) struct DragDeliveryState {
    armed: bool,
    delivery: crate::actions::DeliveryTracker,
}

impl DragDeliveryState {
    pub(crate) fn arm(&mut self) {
        self.armed = true;
    }

    pub(crate) fn mark_down_posted(&mut self) {
        self.delivery.mark_delivered();
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) fn should_release(&self) -> bool {
        self.armed
    }

    pub(crate) fn delivery(&self) -> crate::actions::DeliveryTracker {
        self.delivery
    }

    pub(crate) fn delivery_mut(&mut self) -> &mut crate::actions::DeliveryTracker {
        &mut self.delivery
    }

    pub(crate) fn enrich_error(&self, mut error: AdapterError) -> AdapterError {
        error = self.delivery.annotate(error);
        if self.delivery.delivered_units() == 0 {
            return error;
        }
        let mut details = error
            .details
            .take()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(details) = details.as_object_mut() {
            details.insert(
                "delivered_events".into(),
                self.delivery.delivered_units().into(),
            );
            if self.armed {
                details.insert("emergency_release_posted".into(), true.into());
                details.insert("emergency_release_acknowledged".into(), false.into());
            }
        }
        error.with_details(details).with_suggestion(if self.armed {
            "Inspect the source and destination before retrying; the emergency release was posted without an OS acknowledgement"
        } else {
            "Inspect the source and destination before retrying; the normal release was posted without an OS acknowledgement"
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_delivery_error_does_not_claim_mouse_down_or_release() {
        let state = DragDeliveryState::default();
        let error = state.enrich_error(AdapterError::internal("pre-post failure"));

        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
        assert!(!state.should_release());
    }

    #[test]
    fn deadline_after_down_requires_emergency_release_and_no_retry() {
        let mut state = DragDeliveryState::default();
        state.arm();
        state.mark_down_posted();
        for _ in 0..3 {
            state.delivery_mut().mark_delivered();
        }
        let error = state.enrich_error(AdapterError::timeout("deadline"));
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
        let details = error.details.unwrap();

        assert_eq!(details["delivered_events"], 4);
        assert_eq!(details["emergency_release_posted"], true);
    }

    #[test]
    fn timeout_after_normal_release_does_not_claim_emergency_cleanup() {
        let mut state = DragDeliveryState::default();
        state.arm();
        state.mark_down_posted();
        state.disarm();
        let error = state.enrich_error(AdapterError::timeout("after release"));
        assert!(!error.suggestion.unwrap().contains("emergency release"));
        assert!(
            error
                .details
                .unwrap()
                .get("emergency_release_posted")
                .is_none()
        );
        assert_eq!(
            error.disposition.retry(),
            agent_desktop_core::RetryDisposition::Unsafe
        );
    }
}
