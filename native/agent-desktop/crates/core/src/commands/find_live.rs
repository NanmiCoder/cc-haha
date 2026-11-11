use super::{DEFAULT_LIMIT, FindArgs};
use crate::{
    AdapterError, AppError, LocatorQuery,
    adapter::PlatformAdapter,
    context::CommandContext,
    locator::live_locator::{
        LocatorMaterialization, LocatorResolution, LocatorResolveRequest, LocatorSelection,
        ObservationRoot, resolve_query,
    },
    refs::RefMap,
    refs::refs_store::RefStore,
    snapshot,
    trace::trace_artifacts,
};
use serde_json::{Value, json};
use std::time::Duration;

const LOCATOR_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RAW_DEPTH: u8 = 50;

/// The traversal budget: the caller's if they set one, the shipped default
/// otherwise. Named rather than inlined so a test exercises the same
/// selection a caller reaches, instead of restating the arms beside it.
fn traversal_deadline(args: &FindArgs) -> Result<crate::Deadline, AdapterError> {
    match args.timeout_ms {
        Some(timeout_ms) => crate::Deadline::after(timeout_ms),
        None => crate::Deadline::from_duration(LOCATOR_TIMEOUT),
    }
}

pub(super) fn execute(
    args: &FindArgs,
    query: &LocatorQuery,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let deadline = traversal_deadline(args)?;
    let request = resolve_request(args, deadline);
    let mut resolution = match args.root.as_deref() {
        Some(root_ref) => {
            let (_, local_root_ref) = crate::refs::ref_token::resolve_ref_target(root_ref)?;
            let entry = crate::commands::helpers::load_ref_entry(root_ref, context)?;
            let handle = adapter.resolve_element_strict(&entry, deadline)?;
            resolve_query(
                adapter,
                query,
                ObservationRoot::Element {
                    handle: &handle,
                    entry: &entry,
                    root_ref: Some(&local_root_ref),
                },
                &request,
            )?
        }
        None => {
            let windows = snapshot::surface_windows(
                adapter,
                args.app.as_deref(),
                args.window_id.as_deref(),
                args.surface,
                deadline,
            )?;
            snapshot::first_surface_owner(windows, |window| {
                resolve_query(adapter, query, ObservationRoot::Window(window), &request)
            })?
            .1
        }
    };
    require_complete(&resolution)?;
    let ref_count = resolution.refmap.as_ref().map(RefMap::len);
    let snapshot_id = match resolution.refmap.take() {
        Some(refmap) => Some(persist_refmap(context, &refmap)?),
        None => None,
    };
    if let Some(snapshot_id) = snapshot_id.as_deref() {
        for found in &mut resolution.matches {
            if let Some(local_ref) = found.data.ref_id.as_deref() {
                found.data.ref_id = Some(crate::refs::ref_token::qualify_ref_id(
                    snapshot_id,
                    local_ref,
                ));
            }
        }
    }
    emit_resolution(context, &resolution, snapshot_id.as_deref(), ref_count)?;
    format_response(args, query, resolution, snapshot_id.as_deref())
}

fn resolve_request(args: &FindArgs, deadline: crate::Deadline) -> LocatorResolveRequest {
    let selection = if args.selection.count {
        LocatorSelection::Count
    } else if args.selection.first {
        LocatorSelection::First
    } else if args.selection.last {
        LocatorSelection::Last
    } else if let Some(index) = args.selection.nth {
        LocatorSelection::Nth(u32::try_from(index).unwrap_or(u32::MAX))
    } else {
        LocatorSelection::All {
            limit: args
                .selection
                .limit
                .map_or(Some(DEFAULT_LIMIT as u32), |limit| {
                    (limit != 0).then(|| u32::try_from(limit).unwrap_or(u32::MAX))
                }),
        }
    };
    LocatorResolveRequest {
        selection,
        deadline,
        max_raw_depth: MAX_RAW_DEPTH,
        surface: (args.surface != crate::SnapshotSurface::Window).then_some(args.surface),
        materialization: if args.selection.count {
            LocatorMaterialization::None
        } else {
            LocatorMaterialization::SelectedMatches
        },
    }
}

fn require_complete(resolution: &LocatorResolution) -> Result<(), AppError> {
    if resolution.meta.selection_complete {
        return Ok(());
    }
    Err(
        AdapterError::timeout("Locator traversal did not produce an authoritative result")
            .with_details(json!({
                "kind": "locator_incomplete",
                "observed_matches": resolution.meta.total_matches,
                "query_stats": resolution.stats,
                "roles_present": resolution.meta.roles_present,
            }))
            .into(),
    )
}

fn persist_refmap(context: &CommandContext, refmap: &RefMap) -> Result<String, AppError> {
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = store.save_new_snapshot(refmap)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, refmap)?;
    Ok(snapshot_id)
}

fn emit_resolution(
    context: &CommandContext,
    resolution: &LocatorResolution,
    snapshot_id: Option<&str>,
    ref_count: Option<usize>,
) -> Result<(), AppError> {
    context.trace_lazy("locator.resolve", || {
        json!({
            "complete": resolution.meta.complete,
            "match_count": resolution.meta.total_matches,
            "query_stats": resolution.stats,
            "ref_count": ref_count,
            "snapshot_id": snapshot_id,
            "truncated": resolution.meta.truncated,
        })
    })
}

fn format_response(
    args: &FindArgs,
    query: &LocatorQuery,
    resolution: LocatorResolution,
    snapshot_id: Option<&str>,
) -> Result<Value, AppError> {
    if args.selection.count {
        return Ok(json!({ "count": resolution.meta.total_matches }));
    }
    let total_matches = resolution.meta.total_matches;
    let truncated = resolution.meta.truncated;
    let roles_present = resolution.meta.roles_present;
    let matches = resolution
        .matches
        .into_iter()
        .map(|found| format_match(found.data, found.screen_bounds))
        .collect::<Result<Vec<_>, _>>()?;
    if args.selection.first || args.selection.last || args.selection.nth.is_some() {
        let mut response = single_match_response(matches.into_iter().next(), query, roles_present);
        attach_snapshot_id(&mut response, snapshot_id);
        return Ok(response);
    }
    let mut response = json!({
        "matches": matches,
        "total_matches": total_matches,
        "truncated": truncated,
    });
    let is_empty = response["matches"].as_array().is_some_and(Vec::is_empty);
    attach_roles_present(&mut response, is_empty, query, roles_present);
    attach_snapshot_id(&mut response, snapshot_id);
    Ok(response)
}

fn format_match(
    data: crate::locator::live_locator::LocatorMatchData,
    bounds: Option<crate::Rect>,
) -> Result<Value, serde_json::Error> {
    let needs_geometry = data.ref_id.is_none();
    let mut value = serde_json::to_value(data)?;
    if needs_geometry && let Some(bounds) = bounds {
        value["bounds"] = serde_json::to_value(bounds)?;
    }
    Ok(value)
}

fn attach_snapshot_id(response: &mut Value, snapshot_id: Option<&str>) {
    if let (Some(object), Some(snapshot_id)) = (response.as_object_mut(), snapshot_id) {
        object.insert("snapshot_id".into(), json!(snapshot_id));
    }
}

fn single_match_response(
    found: Option<Value>,
    query: &LocatorQuery,
    roles_present: Vec<String>,
) -> Value {
    let is_empty = found.is_none();
    let mut response = json!({ "match": found });
    attach_roles_present(&mut response, is_empty, query, roles_present);
    response
}

fn attach_roles_present(
    response: &mut Value,
    is_empty: bool,
    query: &LocatorQuery,
    roles_present: Vec<String>,
) {
    if !is_empty || query.identity.role.is_none() {
        return;
    }
    if let Some(object) = response.as_object_mut() {
        object.insert("roles_present".into(), json!(roles_present));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locator::live_locator::{LocatorResolutionMeta, LocatorStats};

    fn args(limit: Option<usize>) -> FindArgs {
        FindArgs {
            app: None,
            window_id: None,
            root: None,
            surface: crate::SnapshotSurface::Window,
            filter: crate::commands::find::FindFilterArgs {
                role: None,
                name: None,
                description: None,
                native_id: None,
                value: None,
                text: None,
                exact: false,
            },
            states: Vec::new(),
            timeout_ms: None,
            selection: crate::commands::find::FindSelectionArgs {
                count: false,
                first: false,
                last: false,
                nth: None,
                limit,
            },
        }
    }

    /// The budget is the caller's to set. Without this, find is fixed at five
    /// seconds and a large tree - a shell file dialog is the measured case -
    /// has no answer but to fail, while snapshot beside it takes --timeout-ms.
    #[test]
    fn an_explicit_budget_reaches_the_traversal_and_absence_keeps_the_default() {
        let mut explicit = args(None);
        explicit.timeout_ms = Some(30_000);
        let deadline = traversal_deadline(&explicit).expect("deadline");
        assert_eq!(deadline.timeout_ms(), 30_000);

        let defaulted = args(None);
        let deadline = traversal_deadline(&defaulted).expect("deadline");
        assert_eq!(
            deadline.timeout_ms(),
            5_000,
            "omitting the flag must leave the shipped default alone"
        );
    }
    #[test]
    fn context_matches_expose_geometry_without_inventing_action_refs() {
        let data = crate::locator::live_locator::LocatorMatchData {
            ref_id: None,
            role: "group".into(),
            name: "(unnamed group)".into(),
            value: None,
            states: Vec::new(),
            interactive: false,
            path: vec!["list".into()],
        };
        let bounds = crate::Rect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 30.0,
        };
        let response = format_match(data.clone(), Some(bounds)).unwrap();

        assert_eq!(response["bounds"], json!(bounds));
        assert!(response["ref_id"].is_null());
        assert!(format_match(data, None).unwrap().get("bounds").is_none());
    }

    #[test]
    fn zero_limit_requests_all_matches() {
        let request = resolve_request(&args(Some(0)), crate::Deadline::standard().unwrap());
        assert_eq!(request.selection, LocatorSelection::All { limit: None });
    }

    #[test]
    fn all_response_exposes_total_and_truncation() {
        let resolution = LocatorResolution {
            matches: Vec::new(),
            refmap: None,
            stats: LocatorStats::default(),
            meta: LocatorResolutionMeta {
                total_matches: 72,
                complete: true,
                selection_complete: true,
                truncated: true,
                roles_present: vec!["button".into()],
            },
        };
        let response =
            format_response(&args(Some(50)), &LocatorQuery::default(), resolution, None).unwrap();

        assert_eq!(response["total_matches"], 72);
        assert_eq!(response["truncated"], true);
    }
}
