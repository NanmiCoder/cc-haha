use super::{LocatorCardinality, LocatorMatch, LocatorResolution};
use crate::{AdapterError, AppError, ErrorCode};
use serde_json::json;

pub fn classify_query_result(resolution: &LocatorResolution) -> LocatorCardinality {
    let observed = resolution.meta.total_matches;
    if observed >= 2 {
        return LocatorCardinality::Many {
            observed,
            exact: resolution.meta.complete,
        };
    }
    if !resolution.meta.complete {
        return LocatorCardinality::Incomplete { observed };
    }
    if observed == 0 {
        LocatorCardinality::Zero
    } else {
        LocatorCardinality::One
    }
}

pub fn require_unique(resolution: LocatorResolution) -> Result<LocatorMatch, AppError> {
    match classify_query_result(&resolution) {
        LocatorCardinality::Zero => Err(AppError::Adapter(
            AdapterError::new(
                ErrorCode::ElementNotFound,
                "Locator query matched no elements",
            )
            .with_suggestion("Use a broader locator or inspect roles_present"),
        )),
        LocatorCardinality::One => resolution.matches.into_iter().next().ok_or_else(|| {
            AppError::Adapter(AdapterError::internal(
                "unique locator resolution did not retain its match",
            ))
        }),
        LocatorCardinality::Many { observed, exact } => {
            let candidates = resolution
                .matches
                .iter()
                .take(10)
                .map(|candidate| {
                    json!({
                        "document_order": candidate.document_order,
                        "name": candidate.data.name,
                        "ref_id": candidate.data.ref_id,
                        "role": candidate.data.role,
                    })
                })
                .collect::<Vec<_>>();
            Err(AppError::Adapter(
                AdapterError::ambiguous_target(format!(
                    "Locator query matched at least {observed} elements"
                ))
                .with_details(json!({
                    "candidate_count": observed,
                    "candidate_count_exact": exact,
                    "candidates": candidates,
                    "query_stats": resolution.stats,
                })),
            ))
        }
        LocatorCardinality::Incomplete { observed } => Err(AppError::Adapter(
            AdapterError::timeout("Locator traversal could not prove a unique result")
                .with_details(json!({
                    "kind": "locator_incomplete",
                    "observed_matches": observed,
                    "query_stats": resolution.stats,
                })),
        )),
    }
}
