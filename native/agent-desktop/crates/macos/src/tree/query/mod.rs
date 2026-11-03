mod arena;
mod child_page;
pub(crate) mod child_read;
pub(crate) mod child_read_budget;
pub(crate) mod child_read_plan;
mod child_read_status;
mod child_read_telemetry;
pub(crate) mod child_source;
mod child_source_availability;
mod evidence_fields;
mod node_evidence;
pub(crate) mod node_read;
pub(crate) mod node_read_context;
pub(crate) mod read_error;
mod traversal;

use crate::tree::AXElement;
use agent_desktop_core::{
    AdapterError, ErrorCode, ObservationRequest, ObservationRoot, ObservationSource, ObservedTree,
    SnapshotSurface,
};
use serde_json::json;

struct ResolvedRoot {
    element: AXElement,
    source: ObservationSource,
    context: crate::tree::TreeBuildContext,
    pid: i32,
    process_instance: Option<String>,
    activation_eligible: bool,
}

/// Whether the walk ran out of tree before it ran out of depth budget, which is
/// what makes an absent renderer surface a conclusion rather than a guess. A
/// depth-clamped observation stops above the web content by design, so its
/// empty result says nothing about whether the renderer is activated — treating
/// it as evidence made every shallow snapshot of a Chromium application demand
/// an activation it did not need, then re-walk the tree until the deadline
/// expired. Reaching the cap is inconclusive either way: the tree may have
/// ended exactly there or been cut, and nothing observed can distinguish them.
fn observation_reached_tree_end(
    stats: &agent_desktop_core::LocatorStats,
    request: &ObservationRequest,
) -> bool {
    stats.traversal.max_logical_depth < request.max_logical_depth
}

pub(crate) fn observe_tree(
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
) -> Result<ObservedTree, AdapterError> {
    let request = (*request).validate()?;
    let deadline = crate::tree::locator_deadline::from_operation(request.deadline)?;
    let resolved = resolve_root(root, &request, deadline)?;
    let (tree, renderer_ready, stats) =
        traversal::LocatorTraversal::new(&request, resolved.context, deadline)
            .build(resolved.element, resolved.source)?;
    tracing::debug!(?stats, "tree: native observation completed");
    let looked_deep_enough = observation_reached_tree_end(&stats, &request);
    if renderer_ready || (resolved.activation_eligible && tree.is_complete()) {
        if let Some(instance) = resolved.process_instance.as_deref() {
            if crate::tree::renderer_probe::activation_required(
                resolved.pid,
                instance,
                renderer_ready,
                tree.is_complete() && looked_deep_enough,
                deadline,
            )? {
                return Err(renderer_activation_required(resolved.pid, stats));
            }
        }
    }
    Ok(tree)
}

fn renderer_activation_required(pid: i32, stats: agent_desktop_core::LocatorStats) -> AdapterError {
    let mut error = AdapterError::renderer_accessibility_activation_required(
        "The application requires accessibility activation before its surface is ready",
    );
    if let Some(details) = error
        .details
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        details.insert("pid".into(), json!(pid));
        details.insert("complete".into(), json!(true));
        details.insert("renderer_ready".into(), json!(false));
        details.insert("query_stats".into(), json!(stats));
    }
    error
}

fn resolve_root(
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
    deadline: std::time::Instant,
) -> Result<ResolvedRoot, AdapterError> {
    let source = ObservationSource::from_root(&root, request.surface);
    match root {
        ObservationRoot::Window(window) => {
            let pid = crate::system::process::process_identity::to_pid_t(window.pid)?;
            let element = resolve_window_surface(window, request.surface, deadline)?;
            let context =
                crate::tree::TreeBuildContext::for_pid_with_deadline(pid, true, deadline)?
                    .child_context(window.bounds);
            Ok(ResolvedRoot {
                element,
                source,
                context,
                pid,
                process_instance: window.process_instance.clone(),
                activation_eligible: request.surface == SnapshotSurface::Window,
            })
        }
        ObservationRoot::Element {
            handle,
            entry,
            root_ref,
        } => {
            verify_entry_process(entry)?;
            let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
            let element = handle.downcast_ref::<AXElement>().cloned().ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Live locator root handle is null or no longer valid",
                )
                .with_suggestion("Refresh the source snapshot and retry the locator")
                .with_details(json!({
                    "kind": "locator_root_invalid",
                    "root_ref": root_ref,
                }))
            })?;
            let context =
                crate::tree::TreeBuildContext::for_pid_with_deadline(pid, true, deadline)?
                    .child_context(crate::tree::element_bounds::ancestor_viewport(
                        &element,
                        request.deadline,
                    )?);
            Ok(ResolvedRoot {
                element,
                source,
                context,
                pid,
                process_instance: entry.process.process_instance.clone(),
                activation_eligible: false,
            })
        }
    }
}

fn verify_entry_process(entry: &agent_desktop_core::RefEntry) -> Result<(), AdapterError> {
    let instance = entry.process.process_instance.as_deref().ok_or_else(|| {
        AdapterError::stale_ref_because("Live locator root has no process instance identity")
    })?;
    let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
    match crate::system::process::process_identity::matches_instance(pid, instance) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AdapterError::stale_ref_because(
            "Live locator root process instance is no longer running",
        )),
        Err(error) if error.code == ErrorCode::InvalidArgs => Err(AdapterError::stale_ref_because(
            "Live locator root has a malformed process instance identity",
        )),
        Err(error) => Err(error),
    }
}

fn resolve_window_surface(
    window: &agent_desktop_core::WindowInfo,
    surface: SnapshotSurface,
    deadline: std::time::Instant,
) -> Result<AXElement, AdapterError> {
    crate::tree::locator_deadline::remaining(deadline)?;
    let pid = crate::system::process::process_identity::to_pid_t(window.pid)?;
    let element = match surface {
        SnapshotSurface::Sheet | SnapshotSurface::Popover | SnapshotSurface::Alert => {
            crate::tree::window_surface::surface_for_window(window, surface, deadline)?.ok_or_else(
                || {
                    AdapterError::new(
                        ErrorCode::ElementNotFound,
                        format!("No open {} in window {}", surface.as_str(), window.id),
                    )
                },
            )?
        }
        SnapshotSurface::Window => {
            crate::system::window::window_resolve::window_element_for_info_with_deadline(
                window, deadline,
            )?
        }
        SnapshotSurface::Focused => crate::tree::surfaces::focused_surface_for_pid(pid, deadline)?
            .ok_or_else(|| AdapterError::element_not_found("No focused surface found"))?,
        SnapshotSurface::Menu => crate::tree::surfaces::menu_element_for_pid(pid, deadline)?
            .ok_or_else(|| AdapterError::element_not_found("No open context menu"))?,
        SnapshotSurface::Menubar => crate::tree::surfaces::menubar_for_pid(pid, deadline)?
            .ok_or_else(|| AdapterError::element_not_found("No menu bar found"))?,
        _ => return Err(AdapterError::not_supported("snapshot surface")),
    };
    crate::tree::locator_deadline::remaining(deadline)?;
    Ok(element)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{
        NativeHandle, ObservationRoot, RefCapabilities, RefEntry, RefEntryIdentity, RefGeometry,
        RefProcess, RefScope, RefSource,
    };

    fn request_with_depth(max_depth: u8) -> ObservationRequest {
        ObservationRequest::snapshot(
            &agent_desktop_core::TreeOptions {
                max_depth,
                ..Default::default()
            },
            agent_desktop_core::Deadline::after(1_000).expect("deadline"),
        )
    }

    fn stats_reaching(max_logical_depth: u8) -> agent_desktop_core::LocatorStats {
        let mut stats = agent_desktop_core::LocatorStats::default();
        stats.traversal.max_logical_depth = max_logical_depth;
        stats
    }

    #[test]
    fn a_walk_that_ended_before_the_cap_can_conclude_the_renderer_is_absent() {
        assert!(observation_reached_tree_end(
            &stats_reaching(4),
            &request_with_depth(10)
        ));
    }

    #[test]
    fn a_walk_that_reached_the_cap_cannot_conclude_anything_about_the_renderer() {
        assert!(
            !observation_reached_tree_end(&stats_reaching(3), &request_with_depth(3)),
            "at the cap the tree may have ended there or been cut, and the observation \
             cannot tell which; demanding activation on that basis re-walked Chromium \
             trees until the deadline expired"
        );
        assert!(!observation_reached_tree_end(
            &stats_reaching(10),
            &request_with_depth(10)
        ));
    }

    #[test]
    fn null_element_root_is_a_structured_stale_ref() {
        let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
        let process_instance = crate::system::process::process_identity::token_for_pid(pid)
            .expect("current process identity read")
            .expect("current process identity");
        let entry = RefEntry {
            process: RefProcess {
                pid: agent_desktop_core::ProcessId::try_from(pid).expect("test pid is positive"),
                process_instance: Some(process_instance),
            },
            identity: RefEntryIdentity {
                retained_object: None,
                role: "button".into(),
                name: Some("Save".into()),
                value: None,
                description: None,
                native_id: None,
            },
            geometry: RefGeometry {
                bounds_space: None,
                bounds: None,
                bounds_hash: None,
            },
            capabilities: RefCapabilities {
                states: Vec::new(),
                available_actions: Vec::new(),
            },
            source: RefSource {
                source_app: Some("Fixture".into()),
                source_window_id: None,
                source_window_title: None,
                source_window_bounds_hash: None,
                source_surface: Default::default(),
            },
            scope: RefScope {
                root_ref: None,
                path_is_absolute: false,
                path: Default::default(),
            },
        };
        let handle = NativeHandle::null();

        let error = resolve_root(
            ObservationRoot::Element {
                handle: &handle,
                entry: &entry,
                root_ref: Some("@e1"),
            },
            &ObservationRequest::snapshot(
                &agent_desktop_core::TreeOptions::default(),
                agent_desktop_core::Deadline::after(1_000).unwrap(),
            ),
            crate::tree::locator_deadline::from_timeout(
                std::time::Instant::now(),
                std::time::Duration::from_secs(1),
            ),
        )
        .err()
        .expect("null root must fail closed");

        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(error.details.unwrap()["kind"], "locator_root_invalid");
    }
}
