use crate::{
    AdapterError, ErrorCode, LiveIdentity, LocatorEvidence, LocatorField, Rect,
    tree::element_state::ElementState,
};

#[derive(Debug, Clone)]
pub struct LiveElement {
    pub identity: LiveIdentity,
    pub state: ElementState,
    pub states_complete: bool,
    pub bounds: Option<Rect>,
    pub available_actions: Vec<String>,
}

/// The answer for a live read that left a field the projection needs unread.
/// It is retryable: the node answered, a field did not.
pub fn incomplete_live_evidence() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Live element evidence was incomplete",
    )
    .with_details(serde_json::json!({
        "kind": "live_element_evidence",
        "complete": false,
        "retryable": true,
    }))
}

/// Whether every slot a single-element live read must answer was observed:
/// role, value, states, bounds and available actions.
pub fn essential_live_evidence_complete(evidence: &LocatorEvidence) -> bool {
    !evidence.role.is_unknown()
        && !evidence.value.is_unknown()
        && !evidence.states.is_unknown()
        && !evidence.ref_evidence.bounds.is_unknown()
        && !evidence.ref_evidence.available_actions.is_unknown()
}

/// The available actions of a live read, with an absent list read as empty
/// and an unread one refused as incomplete evidence.
pub fn known_actions(actions: LocatorField<Vec<String>>) -> Result<Vec<String>, AdapterError> {
    match actions {
        LocatorField::Known(actions) => Ok(actions),
        LocatorField::Absent => Ok(Vec::new()),
        LocatorField::Unknown => Err(incomplete_live_evidence()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{IdentifierEvidence, LocatorRefEvidence};

    fn evidence(role: &str, name: Option<&str>) -> LocatorEvidence {
        LocatorEvidence {
            role: LocatorField::Known(role.to_string()),
            name: name
                .map(|value| LocatorField::Known(value.to_string()))
                .unwrap_or(LocatorField::Absent),
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(Vec::new()),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(Vec::new()),
                descriptors: Default::default(),
            },
        }
    }

    #[test]
    fn incomplete_evidence_is_the_retryable_unresponsive_answer() {
        let error = incomplete_live_evidence();

        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.message, "Live element evidence was incomplete");
        assert_eq!(
            error.details,
            Some(serde_json::json!({
                "kind": "live_element_evidence",
                "complete": false,
                "retryable": true,
            }))
        );
    }

    #[test]
    fn essential_evidence_needs_every_essential_slot_observed() {
        assert!(essential_live_evidence_complete(&evidence("button", None)));

        let unread: [fn(&mut LocatorEvidence); 5] = [
            |evidence| evidence.role = LocatorField::Unknown,
            |evidence| evidence.value = LocatorField::Unknown,
            |evidence| evidence.states = LocatorField::Unknown,
            |evidence| evidence.ref_evidence.bounds = LocatorField::Unknown,
            |evidence| evidence.ref_evidence.available_actions = LocatorField::Unknown,
        ];
        for leave_unread in unread {
            let mut partial = evidence("button", None);
            leave_unread(&mut partial);
            assert!(!essential_live_evidence_complete(&partial));
        }
    }

    #[test]
    fn known_actions_reads_absent_as_empty_and_refuses_unknown() {
        let actions = vec!["Press".to_string()];

        assert_eq!(
            known_actions(LocatorField::Known(actions.clone())).ok(),
            Some(actions)
        );
        assert_eq!(known_actions(LocatorField::Absent).ok(), Some(Vec::new()));
        let refused = known_actions(LocatorField::Unknown).err();
        assert_eq!(
            refused.map(|error| error.code),
            Some(ErrorCode::AppUnresponsive)
        );
    }
}
