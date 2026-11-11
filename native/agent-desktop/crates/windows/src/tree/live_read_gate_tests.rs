//! The essential-completeness gate is a pure predicate over the evidence, so
//! it is pinned here without a UI Automation client and on every target,
//! rather than beside the fixture-driven tests: any essential slot reading
//! `Unknown` - the completeness rule - rejects the bundle, and the rejection
//! error is the retryable `AppUnresponsive` the loop retries instead of a
//! partial answer claiming completeness.
//!
//! What these tests deliberately cannot see is whether the shared read still
//! consults the predicate at all. That wiring is pinned against a real
//! element in `live_read_seam_tests.rs`, because it is only observable
//! through a read that reaches the gate.

use super::{essential_live_evidence_complete, incomplete_live_evidence, stale_reader_error};
use agent_desktop_core::{
    DeliverySemantics, ElementIdentifier, ErrorCode, IdentifierEvidence, IdentifierKind,
    LocatorEvidence, LocatorField, LocatorRefEvidence, NodeDescriptor, Rect,
};

fn complete_evidence() -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known("button".to_string()),
        name: LocatorField::Known("name".to_string()),
        value: LocatorField::Known("value".to_string()),
        description: LocatorField::Absent,
        identifiers: IdentifierEvidence::typed(
            [ElementIdentifier {
                kind: IdentifierKind::AutomationId,
                value: "id-1".to_string(),
            }],
            None,
            true,
        ),
        states: LocatorField::Known(vec!["enabled".to_string()]),
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Known(Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            available_actions: LocatorField::Known(vec!["click".to_string()]),
            descriptors: NodeDescriptor::default(),
        },
    }
}

#[test]
fn a_complete_bundle_passes_the_gate() {
    assert!(essential_live_evidence_complete(&complete_evidence()));
}

#[test]
fn an_unknown_role_fails_the_gate_retryable() {
    let evidence = LocatorEvidence {
        role: LocatorField::Unknown,
        ..complete_evidence()
    };
    assert!(!essential_live_evidence_complete(&evidence));
    let error = incomplete_live_evidence();
    assert!(error.is_explicitly_retryable());
    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppUnresponsive);
}

/// The vanished-target message is what an agent reads, so it is pinned
/// verbatim here as well as at the resolver. Core's `stale_ref` constructor
/// takes a **ref id** and interpolates it into `"{ref_id} not found in current
/// RefMap"`; handing it this sentence produced a message that was
/// ungrammatical and blamed a missing RefMap entry for an element that had
/// resolved and then went invalid mid-read. The retryability is pinned
/// alongside: this error names no `retryable` key, so it must keep the code's
/// default rather than acquire an explicit verdict.
#[test]
fn the_live_read_stale_error_names_the_invalid_element_not_a_missing_refmap_entry() {
    let error = stale_reader_error();

    assert_eq!(
        error.message,
        "Element became invalid while reading live state"
    );
    assert!(
        !error.message.contains("RefMap"),
        "an element that went invalid mid-read is not a missing RefMap entry: {}",
        error.message
    );
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Run 'snapshot' to refresh, then retry with the updated ref.")
    );
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(
        !error.is_explicitly_retryable() && error.permits_retry_by_default(),
        "the derived retryability must survive the construction change"
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("complete"))
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
}

#[test]
fn an_unknown_value_states_bounds_or_actions_fail_the_gate() {
    for field in [
        LocatorEvidence {
            value: LocatorField::Unknown,
            ..complete_evidence()
        },
        LocatorEvidence {
            states: LocatorField::Unknown,
            ..complete_evidence()
        },
        LocatorEvidence {
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Unknown,
                ..complete_evidence().ref_evidence
            },
            ..complete_evidence()
        },
        LocatorEvidence {
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                available_actions: LocatorField::Unknown,
                ..complete_evidence().ref_evidence
            },
            ..complete_evidence()
        },
    ] {
        assert!(!essential_live_evidence_complete(&field));
    }
}
