use agent_desktop_core::{
    AccessibilityNode, AdapterError, AppError, Deadline, ImageFormat, PlatformAdapter, Rect,
    RefEntry, WindowInfo, WindowState, context::CommandContext, refs::refs_store::RefStore,
};
use base64::Engine;
use serde_json::{Value, json};

pub(super) fn window_for_entry(
    entry: &RefEntry,
    adapter: &dyn PlatformAdapter,
    deadline: Deadline,
) -> Result<WindowInfo, AppError> {
    let id =
        entry.source.source_window_id.clone().ok_or_else(|| {
            AppError::invalid_input("Debug capture requires an exact source window")
        })?;
    if entry
        .process
        .process_instance
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return Err(AppError::invalid_input(
            "Debug capture requires a process instance",
        ));
    }
    Ok(adapter.resolve_window_strict(
        &WindowInfo {
            id,
            title: entry.source.source_window_title.clone().unwrap_or_default(),
            app: entry.source.source_app.clone().unwrap_or_default(),
            pid: entry.process.pid,
            process_instance: entry.process.process_instance.clone(),
            bounds: None,
            state: WindowState::default(),
        },
        deadline,
    )?)
}

pub(super) fn click_before(
    args: &crate::cli_args::RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(WindowInfo, Value), AppError> {
    let deadline = Deadline::standard()?;
    let entry = RefStore::for_session(context.session_id())?.load_ref(&args.ref_id)?;
    let handle = adapter.resolve_element_strict(&entry, deadline)?;
    let bounds = adapter.get_element_bounds(&handle, deadline)?;
    let window = window_for_entry(&entry, adapter, deadline)?;
    let node = json!({
        "ref_id": args.ref_id,
        "role": entry.identity.role,
        "name": entry.identity.name,
        "bounds": bounds,
        "reason": "Requested click target, strictly resolved before dispatch. Not the final dispatch geometry.",
        "kind": "target"
    });
    let mut frame = capture_frame(&window, adapter, deadline)?;
    frame["nodes"] = json!([node]);
    Ok((window, frame))
}

pub(super) fn snapshot_frame(
    data: &Value,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let tree: AccessibilityNode = serde_json::from_value(data["tree"].clone())?;
    let ref_id = first_ref(&tree).ok_or_else(|| {
        AppError::invalid_input("No returned ref identifies an exact window for debug capture")
    })?;
    let entry = RefStore::for_session(context.session_id())?.load_ref(ref_id)?;
    let deadline = Deadline::standard()?;
    let window = window_for_entry(&entry, adapter, deadline)?;
    if data["window"]["id"].as_str() != Some(window.id.as_str())
        || entry.source.source_window_bounds_hash != window.bounds.and_then(|b| b.bounds_hash())
    {
        return Err(AdapterError::stale_ref(ref_id).into());
    }
    let mut frame = capture_frame(&window, adapter, deadline)?;
    let mut nodes = Vec::new();
    collect_nodes(&tree, 0, &mut nodes);
    frame["nodes"] = json!(nodes);
    Ok(frame)
}

fn first_ref(node: &AccessibilityNode) -> Option<&str> {
    node.ref_id
        .as_deref()
        .or_else(|| node.children.iter().find_map(first_ref))
}

pub(super) fn collect_nodes(node: &AccessibilityNode, depth: usize, nodes: &mut Vec<Value>) {
    let addressable = agent_desktop_core::refs::ref_alloc::is_ref_able(node);
    let (kind, reason) = if node.ref_id.is_some() && !addressable {
        (
            "drill",
            "Resolvable container retained as a drill-down anchor for a truncated branch.",
        )
    } else if node.ref_id.is_some() {
        (
            "action",
            "Addressable by interactive role or an advertised primary action; not a guarantee of live actionability.",
        )
    } else if depth == 0 {
        (
            "root",
            "Root of the returned accessibility tree. The screenshot frame is its owning window.",
        )
    } else {
        (
            "context",
            "Structural context retained around returned elements; no action ref assigned.",
        )
    };
    let mut item = json!({
        "role": node.role, "depth": depth, "kind": kind, "reason": reason,
    });
    for (key, value) in [
        ("ref_id", json!(node.ref_id)),
        (
            "name",
            json!(
                node.identity
                    .name
                    .as_ref()
                    .or(node.identity.description.as_ref())
            ),
        ),
        ("bounds", json!(node.presentation.bounds)),
        ("children_count", json!(node.children_count)),
    ] {
        if !value.is_null() {
            item[key] = value;
        }
    }
    if node.subtree_truncated {
        item["subtree_truncated"] = json!(true);
    }
    if node
        .presentation
        .states
        .iter()
        .any(|state| matches!(state.as_str(), "hidden" | "offscreen"))
    {
        item["not_visible"] = json!(true);
    }
    nodes.push(item);
    for child in &node.children {
        collect_nodes(child, depth + 1, nodes);
    }
}

pub(super) fn capture_frame(
    window: &WindowInfo,
    adapter: &dyn PlatformAdapter,
    deadline: Deadline,
) -> Result<Value, AppError> {
    let before = adapter.resolve_window_strict(window, deadline)?;
    let bounds = before
        .bounds
        .ok_or_else(|| AppError::invalid_input("Window bounds unavailable"))?;
    bounds.validate()?;
    if window.bounds.is_some() && window.bounds != before.bounds {
        return Err(AppError::invalid_input(
            "Window moved before debug capture; refresh the snapshot",
        ));
    }
    let image = adapter.screenshot_window_frame(&before, deadline)?;
    let after = adapter.resolve_window_strict(&before, deadline)?;
    if before.bounds != after.bounds {
        return Err(AppError::invalid_input(
            "Window moved during debug capture; refresh the snapshot",
        ));
    }
    validate_frame(bounds, image.width, image.height)?;
    if !matches!(image.format, ImageFormat::Png) || image.data.len() > 64 * 1024 * 1024 {
        return Err(AppError::invalid_input(
            "Debug capture requires a PNG no larger than 64 MiB",
        ));
    }
    Ok(json!({
        "image": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&image.data)),
        "window": { "id": before.id, "title": before.title, "app": before.app, "bounds": bounds },
        "width": image.width, "height": image.height,
        "nodes": []
    }))
}

#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;

fn validate_frame(bounds: Rect, width: u32, height: u32) -> Result<(), AppError> {
    let scale_x = width as f64 / bounds.width;
    let scale_y = height as f64 / bounds.height;
    if width == 0
        || height == 0
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || !scale_x.is_finite()
        || !scale_y.is_finite()
        || (scale_x - scale_y).abs() > 0.02
    {
        return Err(AppError::invalid_input(
            "Screenshot does not match the window frame; refusing misaligned highlights",
        ));
    }
    Ok(())
}
