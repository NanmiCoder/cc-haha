use agent_desktop_core::AdapterError;
use core_foundation::array::CFArray;
use std::time::Instant;

use super::cg_window::{WindowDictionary, WindowRecord, WindowRecordScope};

pub(crate) fn exact_window_record_until(
    window_number: i64,
    deadline: Instant,
) -> Result<Option<WindowRecord>, AdapterError> {
    exact_window_record_until_with(window_number, deadline, || {
        let dictionaries = exact_window_dictionaries(window_number)?;
        let mut records = super::cg_window::records_from_dictionaries(
            dictionaries,
            WindowRecordScope::Window(window_number),
        )?;
        super::cg_window::capture_process_instances(&mut records, deadline)?;
        Ok(records)
    })
}

fn exact_window_record_until_with(
    window_number: i64,
    deadline: Instant,
    capture: impl FnOnce() -> Result<Vec<WindowRecord>, AdapterError>,
) -> Result<Option<WindowRecord>, AdapterError> {
    super::cg_window::ensure_before_deadline(deadline)?;
    let mut records = capture()?;
    super::cg_window::ensure_before_deadline(deadline)?;
    if records.len() > 1 {
        return Err(exact_window_source_error(
            "CoreGraphics returned multiple records for one exact window ID",
            window_number,
        ));
    }
    let record = records.pop();
    if record
        .as_ref()
        .is_some_and(|record| record.window_number != window_number)
    {
        return Err(exact_window_source_error(
            "CoreGraphics returned a different record for one exact window ID",
            window_number,
        ));
    }
    Ok(record)
}

fn exact_window_dictionaries(window_number: i64) -> Result<Vec<WindowDictionary>, AdapterError> {
    let window_id = u32::try_from(window_number).map_err(|_| {
        exact_window_source_error("Window ID is outside the CoreGraphics range", window_number)
    })?;
    let requested = CFArray::from_copyable(&[window_id]);
    let descriptions =
        core_graphics::window::create_description_from_array(requested).ok_or_else(|| {
            exact_window_source_error(
                "CGWindowListCreateDescriptionFromArray returned null",
                window_number,
            )
        })?;
    Ok(descriptions.iter().map(|record| record.clone()).collect())
}

fn exact_window_source_error(message: &str, window_number: i64) -> AdapterError {
    super::cg_window::inventory_error(message).with_details(serde_json::json!({
        "kind": "exact_window_inventory_source",
        "source": "core_graphics_exact_window",
        "window_id": format!("w-{window_number}"),
        "complete": false,
        "retryable": true,
    }))
}

#[cfg(test)]
#[path = "cg_window_exact_tests.rs"]
mod tests;
