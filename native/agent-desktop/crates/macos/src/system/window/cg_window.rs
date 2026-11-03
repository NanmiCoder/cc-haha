use agent_desktop_core::{AdapterError, ErrorCode, Rect, WindowInfo};
use core_foundation::{base::CFType, dictionary::CFDictionary, string::CFString};
use std::time::Instant;

pub(in crate::system) type WindowDictionary = CFDictionary<CFString, CFType>;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowRecord {
    pub(crate) app_name: String,
    pub(crate) pid: i32,
    pub(crate) title: Option<String>,
    pub(crate) window_number: i64,
    pub(crate) bounds: Rect,
    pub(crate) visible: bool,
    pub(crate) process_instance: Option<String>,
}

impl WindowRecord {
    pub(crate) fn display_title(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.app_name)
    }

    pub(crate) fn into_window_info(
        self,
        is_focused: bool,
        minimized: Option<bool>,
        accessible: bool,
    ) -> Result<WindowInfo, AdapterError> {
        let title = self.title.unwrap_or_else(|| self.app_name.clone());
        Ok(WindowInfo {
            id: format!("w-{}", self.window_number),
            title,
            app: self.app_name,
            pid: crate::system::process::process_identity::from_pid_t(self.pid)?,
            process_instance: self.process_instance,
            bounds: Some(self.bounds),
            state: agent_desktop_core::WindowState {
                is_focused,
                accessible,
                minimized,
                visible: Some(self.visible),
            },
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) enum WindowRecordScope<'a> {
    Pid(i32),
    Pids(&'a rustc_hash::FxHashSet<i32>),
    Window(i64),
}

impl WindowRecordScope<'_> {
    fn matches(self, pid: i32, window_number: i64) -> bool {
        match self {
            Self::Pid(expected) => pid == expected,
            Self::Pids(expected) => expected.contains(&pid),
            Self::Window(expected) => window_number == expected,
        }
    }
}

pub(crate) fn window_records_until(
    deadline: Instant,
    scope: WindowRecordScope<'_>,
) -> Result<Vec<WindowRecord>, AdapterError> {
    stabilize_records_until(deadline, || capture_once(deadline, scope))
}

fn capture_once(
    deadline: Instant,
    scope: WindowRecordScope<'_>,
) -> Result<Vec<WindowRecord>, AdapterError> {
    ensure_before_deadline(deadline)?;
    let mut records = records_from_dictionaries(window_dictionaries()?, scope)?;
    capture_process_instances(&mut records, deadline)?;
    ensure_before_deadline(deadline)?;
    Ok(records)
}

fn stabilize_records_until(
    deadline: Instant,
    mut capture: impl FnMut() -> Result<Vec<WindowRecord>, AdapterError>,
) -> Result<Vec<WindowRecord>, AdapterError> {
    let mut previous: Option<Vec<WindowRecord>> = None;
    let mut attempts = 0_u64;
    let mut churn_events = 0_u64;
    let mut last_failure: Option<AdapterError> = None;
    loop {
        if Instant::now() >= deadline {
            return Err(expired_deadline_error(
                attempts,
                churn_events,
                last_failure.as_ref(),
            ));
        }
        attempts += 1;
        match capture() {
            Ok(current) => {
                if previous.as_ref().is_some_and(|prior| {
                    inventory_signature(prior) == inventory_signature(&current)
                }) {
                    return Ok(current);
                }
                churn_events += u64::from(previous.is_some());
                previous = Some(current);
                last_failure = None;
            }
            Err(error) if retryable_inventory_error(&error) => {
                previous = None;
                last_failure = Some(error);
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
        }
    }
}

pub(in crate::system) fn records_from_dictionaries(
    dictionaries: Vec<WindowDictionary>,
    scope: WindowRecordScope<'_>,
) -> Result<Vec<WindowRecord>, AdapterError> {
    let mut records = Vec::new();
    for dictionary in dictionaries {
        let layer = required_int_field(&dictionary, "kCGWindowLayer")?;
        if layer != 0 {
            continue;
        }
        let pid = i32::try_from(required_int_field(&dictionary, "kCGWindowOwnerPID")?)
            .map_err(|_| invalid_field_error("kCGWindowOwnerPID"))?;
        if pid <= 0 {
            continue;
        }
        let window_number = required_int_field(&dictionary, "kCGWindowNumber")?;
        if !scope.matches(pid, window_number) {
            continue;
        }
        if dictionary
            .find(CFString::new("kCGWindowOwnerName"))
            .is_none()
        {
            continue;
        }
        let app_name = required_string_field(&dictionary, "kCGWindowOwnerName")?;
        if app_name.is_empty() {
            continue;
        }
        let bounds = rect_field(&dictionary, "kCGWindowBounds")
            .ok_or_else(|| missing_field_error("kCGWindowBounds"))?;
        records.push(WindowRecord {
            app_name,
            pid,
            title: string_field(&dictionary, "kCGWindowName").filter(|title| !title.is_empty()),
            window_number,
            bounds,
            visible: bool_field(&dictionary, "kCGWindowIsOnscreen")?,
            process_instance: None,
        });
    }
    Ok(records)
}

fn window_dictionaries() -> Result<Vec<WindowDictionary>, AdapterError> {
    use crate::tree::properties::cf_type::borrowed_cf_dictionary;
    use core_graphics::display::CGDisplay;
    let options = window_list_options();
    let array = CGDisplay::window_list_info(options, None).ok_or_else(|| {
        inventory_error("CGWindowListCopyWindowInfo returned null instead of a window inventory")
    })?;

    let values = array.get_all_values();
    let mut dictionaries = Vec::with_capacity(values.len());
    for raw in values {
        let dictionary = borrowed_cf_dictionary(raw as core_foundation::base::CFTypeRef)
            .ok_or_else(|| inventory_error("CoreGraphics returned a non-dictionary window"))?;
        dictionaries.push(dictionary);
    }
    Ok(dictionaries)
}

fn window_list_options() -> core_graphics::window::CGWindowListOption {
    core_graphics::window::kCGWindowListOptionAll
        | core_graphics::window::kCGWindowListExcludeDesktopElements
}

pub(in crate::system) fn capture_process_instances(
    records: &mut [WindowRecord],
    deadline: Instant,
) -> Result<(), AdapterError> {
    capture_process_instances_with(records, deadline, |pid| {
        crate::system::process::process_identity::token_for_pid(pid)
    })
}

fn capture_process_instances_with(
    records: &mut [WindowRecord],
    deadline: Instant,
    mut resolve: impl FnMut(i32) -> Result<Option<String>, AdapterError>,
) -> Result<(), AdapterError> {
    let mut instances = std::collections::HashMap::<i32, String>::new();
    for record in records {
        ensure_before_deadline(deadline)?;
        let instance = match instances.entry(record.pid) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.get().clone(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let instance = resolve(record.pid)?
                    .ok_or_else(|| inventory_error("Window owner exited during inventory"))?;
                entry.insert(instance).clone()
            }
        };
        record.process_instance = Some(instance);
    }
    Ok(())
}

type InventorySignatureEntry<'a> = (i32, i64, &'a str, Option<&'a str>, [u64; 4], bool, &'a str);

fn inventory_signature(records: &[WindowRecord]) -> Vec<InventorySignatureEntry<'_>> {
    let mut signature = records
        .iter()
        .map(|record| {
            (
                record.pid,
                record.window_number,
                record.app_name.as_str(),
                record.title.as_deref(),
                [
                    record.bounds.x.to_bits(),
                    record.bounds.y.to_bits(),
                    record.bounds.width.to_bits(),
                    record.bounds.height.to_bits(),
                ],
                record.visible,
                record.process_instance.as_deref().unwrap_or(""),
            )
        })
        .collect::<Vec<_>>();
    signature.sort_unstable();
    signature
}

pub(in crate::system) fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::timeout(
            "CoreGraphics window inventory timed out",
        ));
    }
    Ok(())
}

pub(in crate::system) fn inventory_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::AppUnresponsive, message)
        .with_suggestion("Retry after WindowServer finishes updating the window inventory")
        .with_details(serde_json::json!({
            "kind": "inventory_source",
            "source": "core_graphics_windows",
            "retryable": true,
        }))
}

fn retryable_inventory_error(error: &AdapterError) -> bool {
    error.code == ErrorCode::AppUnresponsive && error.is_explicitly_retryable()
}

fn expired_deadline_error(
    attempts: u64,
    churn_events: u64,
    last_failure: Option<&AdapterError>,
) -> AdapterError {
    if attempts == 0 {
        return AdapterError::timeout(
            "CoreGraphics window inventory deadline elapsed before any capture attempt",
        );
    }
    unstable_inventory_error(attempts, churn_events, last_failure)
}

fn unstable_inventory_error(
    attempts: u64,
    churn_events: u64,
    last_failure: Option<&AdapterError>,
) -> AdapterError {
    let mut details = serde_json::json!({
        "kind": "core_graphics_window_inventory_unstable",
        "attempts": attempts,
        "churn_events": churn_events,
        "retryable": true,
    });
    if let Some(error) = last_failure {
        details["last_failure"] = serde_json::json!(error.message);
        if let Some(failure_details) = &error.details {
            details["last_failure_details"] = failure_details.clone();
        }
    }
    AdapterError::timeout("CoreGraphics window inventory did not stabilize before the deadline")
        .with_suggestion("Retry after active window animations and application launches settle")
        .with_details(details)
}

fn missing_field_error(field: &str) -> AdapterError {
    inventory_error(&format!(
        "CoreGraphics window inventory omitted required field {field}"
    ))
}

fn invalid_field_error(field: &str) -> AdapterError {
    inventory_error(&format!(
        "CoreGraphics window inventory returned invalid field {field}"
    ))
}

fn required_int_field(dict: &WindowDictionary, key: &str) -> Result<i64, AdapterError> {
    int_field(dict, key).ok_or_else(|| missing_field_error(key))
}

fn required_string_field(dict: &WindowDictionary, key: &str) -> Result<String, AdapterError> {
    string_field(dict, key).ok_or_else(|| missing_field_error(key))
}

fn int_field(dict: &WindowDictionary, key: &str) -> Option<i64> {
    use crate::tree::properties::cf_type::borrowed_cf_number;
    use core_foundation::base::TCFType;

    let key = CFString::new(key);
    dict.find(&key)
        .and_then(|value| borrowed_cf_number(value.as_concrete_TypeRef()))
        .and_then(|number| number.to_i64())
}

fn string_field(dict: &WindowDictionary, key: &str) -> Option<String> {
    use crate::tree::properties::cf_type::borrowed_cf_string;
    use core_foundation::base::TCFType;

    let key = CFString::new(key);
    dict.find(&key)
        .and_then(|value| borrowed_cf_string(value.as_concrete_TypeRef()))
        .map(|value| value.to_string())
}

fn bool_field(dict: &WindowDictionary, key: &str) -> Result<bool, AdapterError> {
    use core_foundation::boolean::CFBoolean;

    let cf_key = CFString::new(key);
    let Some(value) = dict.find(&cf_key) else {
        return Ok(false);
    };
    value
        .downcast::<CFBoolean>()
        .map(bool::from)
        .ok_or_else(|| invalid_field_error(key))
}

fn rect_field(dict: &WindowDictionary, key: &str) -> Option<Rect> {
    use crate::tree::properties::cf_type::borrowed_cf_dictionary;
    use core_foundation::base::TCFType;

    let bounds = dict
        .find(CFString::new(key))
        .and_then(|value| borrowed_cf_dictionary(value.as_concrete_TypeRef()))?;
    Some(Rect {
        x: int_or_float_field(&bounds, "X")?,
        y: int_or_float_field(&bounds, "Y")?,
        width: int_or_float_field(&bounds, "Width")?,
        height: int_or_float_field(&bounds, "Height")?,
    })
}

fn int_or_float_field(dict: &WindowDictionary, key: &str) -> Option<f64> {
    use crate::tree::properties::cf_type::borrowed_cf_number;
    use core_foundation::base::TCFType;

    let key = CFString::new(key);
    dict.find(&key)
        .and_then(|value| borrowed_cf_number(value.as_concrete_TypeRef()))
        .and_then(|number| number.to_f64())
}

#[cfg(test)]
#[path = "cg_window_tests.rs"]
mod tests;
