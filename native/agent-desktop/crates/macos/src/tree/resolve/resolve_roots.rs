use agent_desktop_core::{AdapterError, RefEntry, SnapshotSurface};

use super::resolve_read_context::ResolveReadContext;
use crate::tree::AXElement;
use crate::tree::element_dedupe::push_unique;
use crate::tree::properties::element::element_for_pid;

#[cfg(target_os = "macos")]
pub(in crate::tree) struct CandidateRoots {
    pub roots: Vec<AXElement>,
    pub scope_verified: bool,
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn candidate_roots(
    entry: &RefEntry,
    context: &mut ResolveReadContext,
) -> Result<CandidateRoots, AdapterError> {
    let deadline = context.deadline;
    crate::tree::locator_deadline::remaining(deadline)?;
    let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
    let application = element_for_pid(pid);
    if entry.source.source_surface != SnapshotSurface::Window {
        super::resolve_source_app::verify_source_application(&application, entry, context)?;
        return source_surface_scoped_roots(&application, entry, context);
    }
    if source_window_scope_required(entry) && entry.source.source_window_id.is_some() {
        return source_window_scoped_roots(&application, entry, context);
    }
    super::resolve_source_app::verify_source_application(&application, entry, context)?;
    if source_window_scope_required(entry) {
        return source_window_scoped_roots(&application, entry, context);
    }

    let mut roots = Vec::new();
    let windows = read_root_array(&application, "AXWindows", context)?;
    if windows.as_ref().is_some_and(|windows| !windows.is_empty()) {
        add_array(&mut roots, windows);
    } else {
        add_optional_element(
            &mut roots,
            super::resolve_ax_read::read_element(&application, "AXFocusedWindow", deadline)?,
        );
        add_optional_element(
            &mut roots,
            super::resolve_ax_read::read_element(&application, "AXMainWindow", deadline)?,
        );
    }
    add_array(
        &mut roots,
        read_root_array(&application, "AXMenus", context)?,
    );
    add_array(
        &mut roots,
        read_root_array(&application, "AXChildren", context)?,
    );
    crate::tree::locator_deadline::remaining(deadline)?;
    Ok(CandidateRoots {
        roots,
        scope_verified: false,
    })
}

#[cfg(target_os = "macos")]
fn source_surface_scoped_roots(
    application: &AXElement,
    entry: &RefEntry,
    context: &mut ResolveReadContext,
) -> Result<CandidateRoots, AdapterError> {
    let deadline = context.deadline;
    let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
    let root = match entry.source.source_surface {
        SnapshotSurface::Sheet | SnapshotSurface::Popover | SnapshotSurface::Alert
            if entry.source.source_window_id.is_some() =>
        {
            let scoped = match source_window_scoped_roots(application, entry, context) {
                Ok(scoped) => scoped,
                Err(error)
                    if error
                        .details
                        .as_ref()
                        .and_then(|details| details["kind"].as_str())
                        == Some("resolution_window_bridge_miss") =>
                {
                    let root = saved_surface_fallback(entry, |number| {
                        crate::tree::window_surface::surface_for_pid_with_window_number(
                            pid,
                            entry.source.source_surface,
                            Some(number),
                            deadline,
                        )
                    })?;
                    let root = surface_or_bridge_error(root, error)?;
                    return Ok(CandidateRoots {
                        scope_verified: true,
                        roots: vec![root],
                    });
                }
                Err(error) => return Err(error),
            };
            match scoped.roots.into_iter().next() {
                Some(window) => crate::tree::surfaces::surface_in_window(
                    &window,
                    entry.source.source_surface,
                    deadline,
                )?,
                None => None,
            }
        }
        SnapshotSurface::Focused => crate::tree::surfaces::focused_surface_for_pid(pid, deadline)?,
        SnapshotSurface::Menu => crate::tree::surfaces::menu_element_for_pid(pid, deadline)?,
        SnapshotSurface::Menubar => crate::tree::surfaces::menubar_for_pid(pid, deadline)?,
        SnapshotSurface::Sheet => crate::tree::surfaces::sheet_for_pid(pid, deadline)?,
        SnapshotSurface::Popover => crate::tree::surfaces::popover_for_pid(pid, deadline)?,
        SnapshotSurface::Alert => crate::tree::surfaces::alert_for_pid(pid, deadline)?,
        SnapshotSurface::Window => None,
        _ => None,
    };
    let Some(root) = root else {
        return Err(
            AdapterError::element_not_found("saved source surface").with_details(
                serde_json::json!({
                    "kind": "source_surface_absent",
                    "surface": entry.source.source_surface.as_str(),
                    "complete": true,
                    "retryable": true,
                }),
            ),
        );
    };
    Ok(CandidateRoots {
        roots: vec![root],
        scope_verified: true,
    })
}

#[cfg(target_os = "macos")]
fn source_window_scoped_roots(
    application: &AXElement,
    entry: &RefEntry,
    context: &mut ResolveReadContext,
) -> Result<CandidateRoots, AdapterError> {
    let deadline = context.deadline;
    if let Some(id) = entry.source.source_window_id.as_deref() {
        if source_window_number(entry).is_none() {
            return Err(
                AdapterError::element_not_found("saved source window").with_details(
                    serde_json::json!({
                        "kind": "source_window_identity_invalid",
                        "source_window_id": id,
                        "complete": true,
                        "retryable": false,
                    }),
                ),
            );
        }
        crate::system::window::window_resolve::verify_window_identity_until(
            id,
            crate::system::window::window_resolve::WindowIdentityEvidence {
                pid: crate::system::process::process_identity::to_pid_t(entry.process.pid)?,
                app: entry.source.source_app.as_deref(),
                process_instance: entry.process.process_instance.as_deref(),
                title: entry.source.source_window_title.as_deref(),
                bounds_hash: entry.source.source_window_bounds_hash,
            },
            deadline,
        )?;
    }
    let windows = read_root_array(application, "AXWindows", context)?.unwrap_or_default();
    let window = if entry.source.source_window_id.is_some() {
        window_by_number(&windows, entry, context)?
    } else {
        window_by_title(
            &windows,
            entry.source.source_window_title.as_deref(),
            context,
        )?
    };
    let scope_verified =
        source_scope_verified(entry.source.source_window_id.as_deref(), window.is_some());
    Ok(CandidateRoots {
        scope_verified,
        roots: window.into_iter().collect(),
    })
}

pub(in crate::tree) fn source_scope_verified(
    source_window_id: Option<&str>,
    matched: bool,
) -> bool {
    source_window_id.is_some() && matched
}

#[cfg(target_os = "macos")]
fn window_by_number(
    windows: &[AXElement],
    entry: &RefEntry,
    context: &mut ResolveReadContext,
) -> Result<Option<AXElement>, AdapterError> {
    let deadline = context.deadline;
    let Some(source_window_number) = source_window_number(entry) else {
        return Ok(None);
    };
    let mut bridge_unavailable = None;
    let mut found = None;
    let mut match_count = 0_usize;
    for window in windows {
        crate::tree::locator_deadline::remaining(deadline)?;
        match crate::system::window::window_resolve::ax_window_id_with_deadline(window, deadline) {
            Ok(Some(actual)) if actual == source_window_number => {
                match_count += 1;
                if found.is_none() {
                    found = Some(window.clone());
                }
            }
            Ok(_) => {}
            Err(error) if crate::system::window::window_bridge::is_unavailable(&error) => {
                bridge_unavailable = Some(error);
                break;
            }
            Err(error) => return Err(error),
        }
    }
    if let Some(error) = bridge_unavailable {
        return Err(error);
    }
    require_unique_window_number_match(match_count, source_window_number)?;
    found
        .map(Some)
        .ok_or_else(|| window_bridge_miss_error(entry))
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn require_unique_window_number_match(
    match_count: usize,
    window_number: i64,
) -> Result<(), AdapterError> {
    if match_count > 1 {
        return Err(AdapterError::ambiguous_target(format!(
            "Multiple AX windows matched verified CoreGraphics window w-{window_number}"
        ))
        .with_details(serde_json::json!({
            "kind": "source_window_number_ambiguous",
            "source_window_id": format!("w-{window_number}"),
            "candidate_count": match_count,
        })));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn window_by_title(
    windows: &[AXElement],
    source_window_title: Option<&str>,
    context: &mut ResolveReadContext,
) -> Result<Option<AXElement>, AdapterError> {
    let Some(source_window_title) = source_window_title.filter(|title| !title.is_empty()) else {
        return Ok(None);
    };
    let mut found = None;
    for window in windows {
        crate::tree::locator_deadline::remaining(context.deadline)?;
        if super::resolve_ax_read::read_string_with_usage(
            window,
            "AXTitle",
            context.deadline,
            &mut context.usage,
        )?
        .as_deref()
            != Some(source_window_title)
        {
            continue;
        }
        if found.is_some() {
            return Err(AdapterError::ambiguous_target(format!(
                "Multiple windows matched the saved title '{source_window_title}'"
            ))
            .with_details(serde_json::json!({
                "kind": "source_window_title_ambiguous",
                "title": source_window_title,
                "candidate_count_at_least": 2,
            })));
        }
        found = Some(window.clone());
    }
    Ok(found)
}

#[cfg(target_os = "macos")]
fn window_bridge_miss_error(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "The verified CoreGraphics window could not be matched to one live AXWindow",
    )
    .with_suggestion("Retry after the application finishes updating its accessibility windows")
    .with_details(serde_json::json!({
        "kind": "resolution_window_bridge_miss",
        "source_window_id": entry.source.source_window_id,
        "complete": false,
        "retryable": true,
    }))
}

#[cfg(target_os = "macos")]
fn add_optional_element(roots: &mut Vec<AXElement>, element: Option<AXElement>) {
    if let Some(element) = element {
        push_unique(roots, element);
    }
}

#[cfg(target_os = "macos")]
fn add_array(roots: &mut Vec<AXElement>, elements: Option<Vec<AXElement>>) {
    for element in elements.unwrap_or_default() {
        push_unique(roots, element);
    }
}

#[cfg(target_os = "macos")]
fn read_root_array(
    element: &AXElement,
    attribute: &str,
    context: &mut ResolveReadContext,
) -> Result<Option<Vec<AXElement>>, AdapterError> {
    let max_elements = context.usage.child_capacity();
    let read = crate::tree::query::child_read::read_attribute_children(
        element,
        attribute,
        max_elements,
        context.deadline,
    );
    context.stats.reads.counts.child_reads += read.status.attempts;
    context.stats.reads.health.cannot_complete += read.status.health.cannot_complete;
    context.stats.reads.health.native_read_failures += read.status.health.native_read_failures;
    context.stats.reads.health.deadline_exhausted += read.status.health.deadline_exhausted;
    context.stats.traversal.limits.child_count_changes += u64::from(read.status.count_changed);
    context
        .usage
        .note_child_demand(read.total_count, &mut context.stats);
    context.usage.claim_edges(read.elements.len());
    if read.status.api_disabled {
        return Err(AdapterError::permission_denied());
    }
    if read.status.invalid_element || !read.complete || read.truncated() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::AppUnresponsive,
            format!("Strict resolution could not read {attribute} completely"),
        )
        .with_details(serde_json::json!({
            "kind": "resolution_root_array_incomplete",
            "attribute": attribute,
            "complete": false,
            "total_count": read.total_count,
            "loaded_count": read.elements.len(),
            "count_changed": read.status.count_changed,
            "retryable": true,
        })));
    }
    Ok((read.total_count > 0).then_some(read.elements))
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn source_window_scope_required(entry: &RefEntry) -> bool {
    matches!(entry.source.source_surface, SnapshotSurface::Window)
        && (entry.source.source_window_id.is_some()
            || entry
                .source
                .source_window_title
                .as_deref()
                .is_some_and(|title| !title.is_empty()))
}

pub(in crate::tree) fn source_window_number(entry: &RefEntry) -> Option<i64> {
    let number = entry
        .source
        .source_window_id
        .as_deref()?
        .strip_prefix("w-")?
        .parse()
        .ok()?;
    (number > 0).then_some(number)
}

fn saved_surface_fallback<T>(
    entry: &RefEntry,
    find_surface: impl FnOnce(i64) -> Result<Option<T>, AdapterError>,
) -> Result<Option<T>, AdapterError> {
    source_window_number(entry).map_or(Ok(None), find_surface)
}

fn surface_or_bridge_error<T>(surface: Option<T>, error: AdapterError) -> Result<T, AdapterError> {
    surface.ok_or(error)
}

#[cfg(test)]
#[path = "resolve_surface_fallback_tests.rs"]
mod surface_fallback_tests;
