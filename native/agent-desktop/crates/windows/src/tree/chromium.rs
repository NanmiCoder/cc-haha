use agent_desktop_core::{AdapterError, LocatorStats, ObservationRequest, ObservationRoot};

use super::element::UIAElement;
#[cfg(target_os = "windows")]
use super::properties::property_ids::TreeProperty;
#[cfg(target_os = "windows")]
use super::properties::read_one;

/// The top-level window class Chromium ships (A4-4 observed it on Obsidian's
/// top-level and render-host windows). Detection keys on this class alone -
/// an app allowlist would be the macOS renderer-probe anti-pattern this crate
/// deliberately refuses.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// The pre-activation shell shape A16-11 censused: a full-depth walk of a
/// not-yet-settled Chromium root lands in the tens of nodes, against a settled
/// tree of 165. A shell under this line is the connection-triggered-build's
/// before state, not a genuinely small window.
const SHELL_NODE_CEILING: usize = 32;

/// Whether the root window is Chromium/Electron provenance.
///
/// Read from the root element's `ClassName` (a one-property live read, never a
/// second walk). This is what gates the wrapper skip and the activation
/// settle.
#[cfg(target_os = "windows")]
pub(crate) fn is_chromium_root(root: &UIAElement) -> bool {
    let class = read_one(root, TreeProperty::ClassName);
    matches!(
        class.text(),
        agent_desktop_core::LocatorField::Known(name) if name.trim() == CHROMIUM_WINDOW_CLASS
    )
}

/// The non-Windows twin, so the crate's `#![cfg]`-free internal callers compile
/// on the Linux cross-check lane. No real element exists there, so no window is
/// Chromium.
#[cfg(not(target_os = "windows"))]
pub(crate) fn is_chromium_root(_root: &UIAElement) -> bool {
    false
}

/// Whether a full-depth walk of a detected-Chromium root landed on the shell
/// shape.
///
/// A depth-clamped observation never claims this: the walk stopped above the
/// web content by design (the #117 lesson), so its small tree says nothing
/// about the renderer (a depth-clamped walk never demands activation). This is
/// only consulted for a **full-depth** walk.
pub(crate) fn is_shell_shaped(stats: &LocatorStats, request: &ObservationRequest) -> bool {
    reached_full_depth(stats, request) && stats.traversal.nodes_visited <= SHELL_NODE_CEILING as u64
}

/// Whether a walk genuinely ran out of tree rather than being depth-clamped.
///
/// This mirrors macOS's `observation_reached_tree_end` (the #117 lesson): a
/// depth-clamped observation stops above the web content by design, so its
/// small tree says nothing about whether the renderer is activated. Only a
/// walk that ran to a natural end can conclude the tree is genuinely thin.
fn reached_full_depth(stats: &LocatorStats, request: &ObservationRequest) -> bool {
    stats.traversal.max_logical_depth < request.max_logical_depth
}

/// Whether this observation is eligible to trigger renderer activation, the
/// macOS `activation_eligible` gating (`crates/macos/src/tree/query/mod.rs`):
/// a window-rooted, full-depth observation of a Chromium shell.
///
/// An Element-rooted or non-Window-surface walk never demands activation - a
/// drill-down into a shell-shaped subtree returns its thin tree rather than
/// looping the settle.
pub(crate) fn activation_eligible(root: ObservationRoot<'_>, request: &ObservationRequest) -> bool {
    matches!(root, ObservationRoot::Window(_))
        && request.surface == agent_desktop_core::SnapshotSurface::Window
}

/// Builds the activation-required error that core's loop turns into a settle
/// retry. The marker is in `renderer_accessibility_activation_required`.
pub(crate) fn activation_required(stats: &LocatorStats) -> AdapterError {
    let mut error = agent_desktop_core::AdapterError::renderer_accessibility_activation_required(
        "The Chromium renderer has not published its accessibility tree yet",
    );
    if let Some(details) = error
        .details
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        details.insert(
            "nodes_observed".into(),
            serde_json::json!(stats.traversal.nodes_visited),
        );
    }
    error
}

/// The `platform_detail` guidance a tree still thin after settle carries.
///
/// Names Chromium's `--force-renderer-accessibility` switch, and recommends
/// raising `--timeout-ms` when the observation is cut short before the build
/// completes. No target-derived text enters here.
pub(crate) fn still_thin_detail() -> String {
    "The tree is still thin after Chromium's accessibility build settled. \
     If this application is Chromium-based, it may require the \
     --force-renderer-accessibility switch; if the observation is being cut \
     before the build completes, increase snapshot --timeout-ms."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{
        Deadline, LocatorStats, ObservationRequest, ObservationRoot, SnapshotSurface, TreeOptions,
        WindowInfo,
    };

    fn request(max_depth: u8) -> ObservationRequest {
        let options = TreeOptions {
            max_depth,
            ..TreeOptions::default()
        };
        ObservationRequest::snapshot(&options, Deadline::after(5_000).unwrap())
    }

    fn stats(nodes: u64, max_logical_depth: u8) -> LocatorStats {
        let mut stats = LocatorStats::default();
        stats.traversal.nodes_visited = nodes;
        stats.traversal.max_logical_depth = max_logical_depth;
        stats
    }

    fn window_root() -> ObservationRoot<'static> {
        let window: &'static WindowInfo = Box::leak(Box::new(WindowInfo {
            id: "w-1".into(),
            title: String::new(),
            app: String::new(),
            pid: agent_desktop_core::ProcessId::new(1),
            process_instance: None,
            bounds: None,
            state: Default::default(),
        }));
        ObservationRoot::Window(window)
    }

    /// The #117 lesson pinned: a depth-clamped walk of a Chromium root never
    /// claims the shell shape, so it never demands activation.
    #[test]
    fn a_depth_clamped_walk_never_looks_shell_shaped() {
        let request = request(3);
        let stats = stats(12, 3);

        assert!(!is_shell_shaped(&stats, &request));
    }

    #[test]
    fn a_full_depth_shell_is_shell_shaped() {
        let request = request(50);
        let stats = stats(12, 12);

        assert!(is_shell_shaped(&stats, &request));
    }

    #[test]
    fn a_full_depth_settled_tree_is_not_shell_shaped() {
        let request = request(50);
        let stats = stats(165, 20);

        assert!(!is_shell_shaped(&stats, &request));
    }

    /// Depth is not this predicate's business: `reached_full_depth` and
    /// `is_shell_shaped` decide that, and the tests above drive them. This one
    /// covers the two clauses `activation_eligible` does consult - the root
    /// kind and the requested surface.
    #[test]
    fn activation_is_eligible_only_for_window_rooted_window_surface_observations() {
        let request = request(50);
        assert!(activation_eligible(window_root(), &request));

        let focused = ObservationRequest::snapshot(
            &TreeOptions {
                surface: SnapshotSurface::Focused,
                ..TreeOptions::default()
            },
            Deadline::after(5_000).unwrap(),
        );
        assert!(!activation_eligible(window_root(), &focused));
    }

    /// The other clause of the same predicate: an element-rooted observation
    /// is never eligible, whatever its surface.
    ///
    /// A drill-down into a shell-shaped subtree must return its thin tree
    /// rather than demanding activation, because the settle it would demand
    /// has already run for that window - core's loop would re-walk the same
    /// subtree indefinitely. Testing only window roots leaves this clause
    /// deletable with the suite green.
    #[test]
    fn an_element_rooted_observation_is_never_eligible_for_activation() {
        let request = request(50);
        let entry: &'static agent_desktop_core::RefEntry =
            Box::leak(Box::new(agent_desktop_core::RefEntry {
                process: agent_desktop_core::RefProcess {
                    pid: agent_desktop_core::ProcessId::new(1),
                    process_instance: None,
                },
                identity: agent_desktop_core::RefEntryIdentity {
                    retained_object: None,
                    role: "button".into(),
                    name: None,
                    value: None,
                    description: None,
                    native_id: None,
                },
                geometry: agent_desktop_core::RefGeometry {
                    bounds_space: None,
                    bounds: None,
                    bounds_hash: None,
                },
                capabilities: agent_desktop_core::RefCapabilities {
                    states: Vec::new(),
                    available_actions: Vec::new(),
                },
                source: agent_desktop_core::RefSource {
                    source_app: None,
                    source_window_id: None,
                    source_window_title: None,
                    source_window_bounds_hash: None,
                    source_surface: SnapshotSurface::Window,
                },
                scope: agent_desktop_core::RefScope {
                    root_ref: None,
                    path_is_absolute: true,
                    path: agent_desktop_core::refs::RefPath::default(),
                },
            }));
        let handle: &'static agent_desktop_core::NativeHandle =
            Box::leak(Box::new(agent_desktop_core::NativeHandle::new(())));

        let element_root = ObservationRoot::Element {
            handle,
            entry,
            root_ref: None,
        };

        assert_eq!(
            request.surface,
            SnapshotSurface::Window,
            "the surface clause must be satisfied, so only the root clause can refuse this"
        );
        assert!(!activation_eligible(element_root, &request));
    }
}
