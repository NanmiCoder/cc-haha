use super::{
    LocatorResolution, LocatorResolveRequest, LocatorStats, ObservationRequest, ObservationRoot,
    evaluate_locator_tree, validate_query, validate_request,
};
use crate::{AdapterError, AppError, ErrorCode, adapter::PlatformAdapter, locator::LocatorQuery};
use serde_json::json;
use std::time::{Duration, Instant};

pub fn resolve_query(
    adapter: &dyn PlatformAdapter,
    query: &LocatorQuery,
    root: ObservationRoot<'_>,
    request: &LocatorResolveRequest,
) -> Result<LocatorResolution, AppError> {
    validate_query(query)?;
    validate_request(request)?;
    let started = Instant::now();
    let deadline = request.deadline;
    let mut aggregate = LocatorStats::default();
    let mut last_incomplete = None;
    let mut selection_retry_used = false;
    loop {
        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return Err(transient_incomplete_timeout(deadline, &aggregate, last_incomplete).into());
        }
        let attempt_request = LocatorResolveRequest { ..*request };
        match resolve_query_attempt(adapter, query, root, &attempt_request, &mut aggregate) {
            Ok(mut resolution) => {
                resolution.stats.reads.counts.observation_attempts =
                    resolution.stats.reads.counts.observation_attempts.max(1);
                if !resolution.meta.selection_complete && has_deterministic_limit(&resolution.stats)
                {
                    return Err(deterministic_limit_error(&resolution).into());
                }
                if !resolution.meta.selection_complete
                    && has_transient_incompleteness(&resolution.stats)
                {
                    last_incomplete = Some(incomplete_evidence(&resolution));
                    aggregate.merge_attempt(&resolution.stats);
                    if deadline.is_expired() {
                        return Err(transient_incomplete_timeout(
                            deadline,
                            &aggregate,
                            last_incomplete,
                        )
                        .into());
                    }
                    let remaining = deadline.remaining();
                    crate::wait::deadline::sleep(remaining.min(Duration::from_millis(10)));
                    continue;
                }
                if !resolution.meta.selection_complete && requires_authoritative_result(request) {
                    return Err(unknown_incomplete_error(&resolution).into());
                }
                aggregate.merge_attempt(&resolution.stats);
                aggregate.elapsed_us =
                    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
                resolution.stats = aggregate;
                return Ok(resolution);
            }
            Err(AppError::Adapter(error))
                if request.materialization == super::LocatorMaterialization::SelectedMatches
                    && super::hydrate::retryable_error(&error)
                    && !selection_retry_used
                    && !deadline.is_expired() =>
            {
                selection_retry_used = true;
                last_incomplete = Some(json!({
                    "phase": "hydration",
                    "code": error.code.as_str(),
                    "details": error.details,
                }));
                let remaining = deadline.remaining();
                crate::wait::deadline::sleep(remaining.min(Duration::from_millis(10)));
            }
            Err(error) => return Err(error),
        }
    }
}

fn requires_authoritative_result(request: &LocatorResolveRequest) -> bool {
    request.materialization == super::LocatorMaterialization::SelectedMatches
        || !matches!(
            request.selection,
            super::LocatorSelection::All { .. } | super::LocatorSelection::Count
        )
}

fn unknown_incomplete_error(resolution: &LocatorResolution) -> AdapterError {
    AdapterError::timeout("Locator traversal returned incomplete evidence")
        .with_suggestion("Retry with a narrower locator or a larger observation budget")
        .with_details(json!({
            "kind": "locator_incomplete",
            "retryable": false,
            "observed_matches": resolution.meta.total_matches,
            "query_stats": resolution.stats,
        }))
        .with_disposition(crate::DeliverySemantics::not_delivered())
}

pub(super) fn has_deterministic_limit(stats: &LocatorStats) -> bool {
    let limits = &stats.traversal.limits;
    limits.node_hits > 0
        || limits.edge_hits > 0
        || limits.child_hits > 0
        || limits.text_hits > 0
        || limits.depth_hits > 0
}

fn has_transient_incompleteness(stats: &LocatorStats) -> bool {
    stats.traversal.limits.child_count_changes > 0
        || stats.reads.health.cannot_complete > 0
        || stats.reads.health.deadline_exhausted > 0
}

fn deterministic_limit_error(resolution: &LocatorResolution) -> AdapterError {
    AdapterError::new(
        ErrorCode::Timeout,
        "Locator traversal reached a deterministic observation budget",
    )
    .with_suggestion(
        "Use a narrower locator, a shallower scope, or increase the matching observation budget",
    )
    .with_details(json!({
        "kind": "locator_budget_limit",
        "retryable": false,
        "observed_matches": resolution.meta.total_matches,
        "limits": resolution.stats.traversal.limits,
        "query_stats": resolution.stats,
    }))
    .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn incomplete_evidence(resolution: &LocatorResolution) -> serde_json::Value {
    json!({
        "observed_matches": resolution.meta.total_matches,
        "child_count_changes": resolution.stats.traversal.limits.child_count_changes,
        "cannot_complete": resolution.stats.reads.health.cannot_complete,
        "deadline_exhausted": resolution.stats.reads.health.deadline_exhausted,
    })
}

fn transient_incomplete_timeout(
    deadline: crate::Deadline,
    stats: &LocatorStats,
    last_incomplete: Option<serde_json::Value>,
) -> AdapterError {
    AdapterError::timeout("Locator observation did not stabilize before its deadline")
        .with_suggestion(
            "Retry with a larger timeout or narrow the locator to a more stable subtree",
        )
        .with_details(json!({
            "kind": "locator_transient_incomplete",
            "retryable": true,
            "timeout_ms": deadline.timeout_ms(),
            "observation_attempts": stats.reads.counts.observation_attempts,
            "last_incomplete": last_incomplete,
            "query_stats": stats,
        }))
        .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn resolve_query_attempt(
    adapter: &dyn PlatformAdapter,
    query: &LocatorQuery,
    root: ObservationRoot<'_>,
    request: &LocatorResolveRequest,
    aggregate: &mut LocatorStats,
) -> Result<LocatorResolution, AppError> {
    let observation_request =
        ObservationRequest::locator_for_root(query, request, root, observation_deadline(request))
            .validate()?;
    let tree =
        crate::tree::renderer_accessibility::observe_tree(adapter, root, &observation_request)?;
    let mut tree = tree;
    tree.stats.reads.counts.observation_attempts =
        tree.stats.reads.counts.observation_attempts.max(1);
    let evaluation_request = LocatorResolveRequest {
        materialization: match request.materialization {
            super::LocatorMaterialization::SelectedMatches => super::LocatorMaterialization::None,
            other => other,
        },
        ..*request
    };
    let mut resolution = evaluate_locator_tree(tree, query, &evaluation_request)?;
    if request.materialization == super::LocatorMaterialization::SelectedMatches {
        if let Err(error) =
            super::hydrate::selected_matches(adapter, query, request, &mut resolution)
        {
            aggregate.merge_attempt(&resolution.stats);
            return Err(error);
        }
    }
    Ok(resolution)
}

fn observation_deadline(request: &LocatorResolveRequest) -> crate::Deadline {
    if request.materialization != super::LocatorMaterialization::SelectedMatches {
        return request.deadline;
    }
    let remaining = request.deadline.remaining();
    let reserve = (remaining / 2).min(Duration::from_secs(1));
    request.deadline.capped(remaining.saturating_sub(reserve))
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn selected_ref_hydration_has_budget_without_extending_the_operation() {
        let request = LocatorResolveRequest {
            selection: super::super::LocatorSelection::First,
            deadline: crate::Deadline::after(60_000).unwrap(),
            max_raw_depth: 50,
            surface: None,
            materialization: super::super::LocatorMaterialization::SelectedMatches,
        };
        let observation = observation_deadline(&request);
        assert!(observation.was_capped());
        assert!(!request.deadline.was_capped());
        assert_eq!(observation.timeout_ms(), request.deadline.timeout_ms());
        let count_request = LocatorResolveRequest {
            materialization: super::super::LocatorMaterialization::None,
            ..request
        };
        assert_eq!(observation_deadline(&count_request), request.deadline);
    }
}
