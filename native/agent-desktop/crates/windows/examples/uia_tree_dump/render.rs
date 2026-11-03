use agent_desktop_core::{Deadline, ObservationRoot, ProcessId, WindowInfo, WindowState};
use agent_desktop_windows::tree::automation::failure_of;
use agent_desktop_windows::tree::element::UIAElement;
use agent_desktop_windows::tree::name_evidence::read_label;
use agent_desktop_windows::tree::properties::property_ids::TreeProperty;
use agent_desktop_windows::tree::properties::{read_live, read_one};
use agent_desktop_windows::tree::walk::walker::{NodeKey, TreeSource, WalkBudget, walk_vocabulary};
use agent_desktop_windows::tree::walk::walker_source::{UiaTreeSource, walk_uia_subtree};
use serde_json::{Value, json};
use std::collections::BTreeSet;

use super::render_census::{control_type_census, provider_census, sample, vocabulary_summary};
use super::render_node::{NodeFields, Position, render_node};
use super::select::Options;

/// Reads one element and renders it.
///
/// The whole `Position` travels rather than just its parent and index: the
/// renderer ignores `depth`, but inventing a zero for it here would put a
/// value in the struct that is not true of the node.
fn node(element: &UIAElement, at: Position) -> Value {
    let (properties, errors) = read_live(element);
    let label = read_label(element, false);
    let vocabulary = walk_vocabulary(&properties, &label);
    let provider_description = read_one(element, TreeProperty::ProviderDescription);
    render_node(&NodeFields {
        position: at,
        properties,
        vocabulary,
        label,
        provider_description,
        failed_reads: errors.len(),
    })
}

/// What bounds the census recursion.
///
/// `--max-depth` alone is adequate for a census of a fixture and is not
/// adequate for a tool a human points at an arbitrary window: a provider that
/// publishes a cyclic child graph or an endless sibling list would hang it.
/// This carries the same three bounds the shipped walker has - a deadline, an
/// ancestor-path cycle guard keyed on the identity the provider publishes, and
/// a sibling cap.
///
/// **The deadline is re-checked inside the sibling loop, not only on entry to
/// each node.** A check at entry alone stops the recursion but not the
/// enumeration: every `next_sibling` is a cross-process call, so an expired
/// deadline would still issue up to the sibling cap's worth of them per parent
/// while each recursive call returned immediately. `walker_enumerate.rs`
/// checks both bounds in the same place for the same reason.
///
/// **A failed enumeration is not the end of a list.** UI Automation signals
/// both as `Err`, distinguished only by `is_exhaustion()` - the benign pair
/// A14-3 measured against the real fault A14-4 measured. Treating them alike
/// makes a provider that died mid-walk produce a short census reporting
/// `truncated: false`, which is a partial answer that reads as a complete one.
/// Every enumeration arm here consults the discriminator, as the shipped
/// walker does.
struct Bounds {
    max_depth: u8,
    deadline: Deadline,
    ancestors: Vec<Vec<i32>>,
    truncated: bool,
}

const MAX_CENSUS_SIBLINGS: usize = 10_000;

fn collect(
    source: &UiaTreeSource,
    element: &UIAElement,
    at: Position,
    bounds: &mut Bounds,
    nodes: &mut Vec<Value>,
) {
    if bounds.deadline.is_expired() {
        bounds.truncated = true;
        return;
    }
    let key = match source.identity(element) {
        NodeKey::Runtime(runtime_id) => Some(runtime_id),
        NodeKey::Unavailable => None,
    };
    if let Some(key) = &key {
        if bounds.ancestors.contains(key) {
            bounds.truncated = true;
            return;
        }
    }
    let position = nodes.len();
    nodes.push(node(element, at));
    if at.depth >= bounds.max_depth {
        bounds.truncated = true;
        return;
    }
    if let Some(key) = key.clone() {
        bounds.ancestors.push(key);
    }
    let mut child = match source.first_child(element) {
        Ok(first) => first,
        Err(failure) => {
            if !failure.is_exhaustion() {
                bounds.truncated = true;
            }
            if key.is_some() {
                bounds.ancestors.pop();
            }
            return;
        }
    };
    let mut child_index = 0;
    loop {
        let next = source.next_sibling(&child);
        collect(
            source,
            &child,
            Position {
                parent: Some(position),
                index: child_index,
                depth: at.depth + 1,
            },
            bounds,
            nodes,
        );
        child_index += 1;
        if child_index >= MAX_CENSUS_SIBLINGS || bounds.deadline.is_expired() {
            bounds.truncated = true;
            break;
        }
        match next {
            Ok(sibling) => child = sibling,
            Err(failure) => {
                if !failure.is_exhaustion() {
                    bounds.truncated = true;
                }
                break;
            }
        }
    }
    if key.is_some() {
        bounds.ancestors.pop();
    }
}

/// Walks the target and renders the capture.
///
/// The traversal runs on the shipped `TreeSource`, so the dump exercises the
/// same enumeration surface and cache policy the adapter uses and can never
/// reach the banned `get_children`.
pub fn dump(
    root: &UIAElement,
    hwnd: isize,
    options: &Options,
    deadline: Deadline,
) -> Result<String, String> {
    let source = UiaTreeSource::for_root(root).map_err(|error| error.message.clone())?;
    let prepared = source
        .prepare_root(root)
        .map_err(|error| error.message.clone())?;
    let mut nodes = Vec::new();
    let mut bounds = Bounds {
        max_depth: options.max_depth,
        deadline,
        ancestors: Vec::new(),
        truncated: false,
    };
    collect(
        &source,
        &prepared,
        Position {
            parent: None,
            index: 0,
            depth: 0,
        },
        &mut bounds,
        &mut nodes,
    );
    let document = json!({
        "capture": "uia-vocabulary-census",
        "client_stack": "uia3-com",
        "crate": "uiautomation 0.25.0",
        "target_class": options.class_name,
        "target_variant": options.variant,
        "os_build": os_build(),
        "max_depth": options.max_depth,
        "census_truncated": bounds.truncated,
        "node_count": nodes.len(),
        "walk": walk_verdict(&prepared, deadline),
        "vocabulary": vocabulary_summary(&nodes),
        "view_delta": view_delta(hwnd, options.max_depth, deadline),
        "control_types": control_type_census(&nodes),
        "providers": provider_census(&nodes),
        "sample": sample(&nodes),
    });
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
}

/// The RawView-versus-ControlView delta is reported rather than reconciled:
/// the raw-view and control-view counts are emitted side by side.
///
/// A15-10 measured them identical on a Win32 fixture and five nodes apart on
/// WPF, so the delta is provider-dependent. Reporting it per real target is
/// what lets that choice be made on data rather than on an argument.
fn view_delta(hwnd: isize, max_depth: u8, deadline: Deadline) -> Value {
    let count = |control_view: bool| -> Value {
        match count_view(hwnd, control_view, max_depth, deadline) {
            Err(reason) => json!({ "failed": reason }),
            Ok(count) => json!({
                "nodes": count.nodes,
                "truncated": count.truncated,
                "control_types": count.control_types.into_iter().collect::<Vec<_>>(),
            }),
        }
    };
    json!({ "raw_view": count(false), "control_view": count(true) })
}

/// What one tree view presented, and whether the walk saw all of it.
struct ViewCount {
    nodes: usize,
    control_types: BTreeSet<i32>,
    truncated: bool,
}

/// Counts the nodes and distinct control types one tree view presents.
///
/// Enumerated with `get_first_child`/`get_next_sibling` rather than the
/// crate's `get_children`, which retires end-of-siblings and a real
/// cross-process fault through the same arm.
///
/// **Every loop here is bounded, including the inner sibling loop.** The
/// ancestor guard the shipped walker uses cannot see a sibling chain that
/// never terminates - no element repeats on any root-to-node path - so a
/// provider whose `get_next_sibling` cycles would spin this loop forever and
/// grow the pending stack without limit. Depth bounds descent, the sibling cap
/// bounds breadth, and the deadline bounds both; the count reports whether any
/// of them fired, because a truncated census that says nothing reads as a
/// complete one.
fn count_view(
    hwnd: isize,
    control_view: bool,
    max_depth: u8,
    deadline: Deadline,
) -> Result<ViewCount, String> {
    use agent_desktop_windows::tree::automation::automation_client;
    let client = automation_client().map_err(|error| error.message.clone())?;
    let walker = if control_view {
        client.get_control_view_walker()
    } else {
        client.get_raw_view_walker()
    }
    .map_err(|error| error.to_string())?;
    let mut count = ViewCount {
        nodes: 0,
        control_types: BTreeSet::new(),
        truncated: false,
    };
    let root = client
        .element_from_handle(uiautomation::types::Handle::from(hwnd))
        .map_err(|error| error.to_string())?;
    let mut stack = vec![(root, 0_u8)];
    while let Some((element, depth)) = stack.pop() {
        if deadline.is_expired() {
            count.truncated = true;
            break;
        }
        count.nodes += 1;
        if let Ok(uiautomation::variants::Value::I4(id)) = element
            .get_property_value(uiautomation::types::UIProperty::ControlType)
            .and_then(|variant| variant.get_value())
        {
            count.control_types.insert(id);
        }
        if depth >= max_depth {
            count.truncated = true;
            continue;
        }
        let mut child = match walker.get_first_child(&element) {
            Ok(first) => first,
            Err(error) => {
                if !failure_of(&error).is_exhaustion() {
                    count.truncated = true;
                }
                continue;
            }
        };
        let mut siblings = 0;
        loop {
            let next = walker.get_next_sibling(&child);
            stack.push((child, depth + 1));
            siblings += 1;
            if siblings >= MAX_CENSUS_SIBLINGS || deadline.is_expired() {
                count.truncated = true;
                break;
            }
            match next {
                Ok(sibling) => child = sibling,
                Err(error) => {
                    if !failure_of(&error).is_exhaustion() {
                        count.truncated = true;
                    }
                    break;
                }
            }
        }
    }
    Ok(count)
}

fn os_build() -> String {
    std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_string())
        .unwrap_or_else(|| String::from("<unrecorded>"))
}

/// Runs the shipped walker over the same target and reports its verdict.
///
/// This is the evidence that matters beyond the node list: whether the
/// traversal the adapter ships reports a real application's tree **complete**.
/// An inverted discriminator or a swallowed enumeration fault shows up here as
/// a false `true`, which is why the capture records the failure count beside
/// it rather than the verdict alone.
fn walk_verdict(root: &UIAElement, deadline: Deadline) -> Value {
    let window = WindowInfo {
        id: String::from("<hwnd>"),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::from(0_u32),
        process_instance: None,
        bounds: None,
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: None,
            visible: Some(true),
        },
    };
    match walk_uia_subtree(
        root,
        &ObservationRoot::Window(&window),
        WalkBudget::new(u8::MAX, deadline),
    ) {
        Ok(outcome) => {
            let failures = outcome.failures.len();
            let cycles_skipped = outcome.stats.traversal.cycles_skipped;
            match outcome.tree.into_accessibility_tree_partial() {
                Ok((_, structurally_complete, nodes_observed)) => json!({
                    "structurally_complete": structurally_complete,
                    "nodes_observed": nodes_observed,
                    "enumeration_failures": failures,
                    "cycles_skipped": cycles_skipped,
                }),
                Err(error) => json!({ "failed": error.message }),
            }
        }
        Err(error) => json!({ "failed": error.message }),
    }
}
