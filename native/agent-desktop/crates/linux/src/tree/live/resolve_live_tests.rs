use agent_desktop_core::{Deadline, ObservationOps, RefEntry, TreeOptions, WindowFilter, snapshot};

use crate::LinuxAdapter;
use crate::system::window::window_id;
use crate::tree::AtspiElement;

fn entries(result: &snapshot::SnapshotResult) -> Vec<(String, RefEntry)> {
    let value = serde_json::to_value(&result.refmap).expect("a refmap serializes");
    let inner = value["inner"]
        .as_object()
        .expect("a refmap holds its entries");
    let mut found: Vec<(String, RefEntry)> = inner
        .iter()
        .map(|(id, entry)| {
            (
                id.clone(),
                serde_json::from_value(entry.clone()).expect("an entry deserializes"),
            )
        })
        .collect();
    found.sort_by_key(|(id, _)| id.trim_start_matches("@e").parse::<u32>().unwrap_or(0));
    found
}

pub(in crate::tree) fn snapshot_entries(
    adapter: &LinuxAdapter,
    frame: &AtspiElement,
    include_bounds: bool,
) -> Result<Vec<(String, RefEntry)>, String> {
    let deadline = Deadline::after(15_000).map_err(|error| error.message)?;
    let id = window_id::encode(frame.bus_name(), frame.path()).ok_or("the frame has no id")?;
    let windows = adapter
        .list_windows(&WindowFilter::default(), deadline)
        .map_err(|error| error.message)?;
    let window = windows
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("window {id} is not listed"))?;
    let options = TreeOptions {
        include_bounds,
        ..TreeOptions::default()
    };
    let result = snapshot::build(adapter, &options, None, Some(&window.id), deadline)
        .map_err(|error| error.to_string())?;
    Ok(entries(&result))
}
