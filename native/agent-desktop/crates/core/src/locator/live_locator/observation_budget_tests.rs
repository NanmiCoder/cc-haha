use super::*;

#[test]
fn defaults_are_valid_hard_limits() {
    let budget = ObservationBudget::default().validate().unwrap();
    assert_eq!(budget.max_nodes, MAX_OBSERVATION_NODES);
    assert_eq!(budget.max_edges, MAX_OBSERVATION_EDGES);
    assert_eq!(budget.max_children_per_node, MAX_CHILDREN_PER_NODE);
    assert_eq!(budget.max_field_bytes, MAX_OBSERVATION_FIELD_BYTES);
    assert_eq!(budget.max_text_bytes, MAX_OBSERVATION_TEXT_BYTES);
}

#[test]
fn zero_and_oversized_limits_are_rejected() {
    for budget in [
        ObservationBudget {
            max_nodes: 0,
            ..ObservationBudget::default()
        },
        ObservationBudget {
            max_edges: MAX_OBSERVATION_EDGES + 1,
            ..ObservationBudget::default()
        },
        ObservationBudget {
            max_children_per_node: 0,
            ..ObservationBudget::default()
        },
        ObservationBudget {
            max_field_bytes: MAX_OBSERVATION_FIELD_BYTES + 1,
            ..ObservationBudget::default()
        },
        ObservationBudget {
            max_text_bytes: MAX_OBSERVATION_TEXT_BYTES + 1,
            ..ObservationBudget::default()
        },
    ] {
        assert_eq!(budget.validate().unwrap_err().code, ErrorCode::InvalidArgs);
    }
}

#[test]
fn field_budget_must_fit_total_text_budget() {
    let error = ObservationBudget {
        max_field_bytes: 2,
        max_text_bytes: 1,
        ..ObservationBudget::default()
    }
    .validate()
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}
