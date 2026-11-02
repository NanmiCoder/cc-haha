use super::{BridgedWorkspaceSnapshot, MAX_FIELD_BYTES, MAX_SNAPSHOT_BYTES, inventory_error};
use agent_desktop_core::AdapterError;
use serde_json::{Value, json};

pub(super) fn bridged_snapshot(bytes: &[u8]) -> Result<BridgedWorkspaceSnapshot, AdapterError> {
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(inventory_error("AppKit returned an oversized snapshot"));
    }
    let mut snapshot: Value = serde_json::from_slice(bytes)
        .map_err(|_| inventory_error("AppKit returned invalid JSON"))?;
    let mut skipped = snapshot
        .get("skipped")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let applications = snapshot
        .get_mut("applications")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| with_skipped(inventory_error("AppKit omitted applications"), &skipped))?;
    let mut seen: rustc_hash::FxHashMap<Option<i64>, Value> = rustc_hash::FxHashMap::default();
    applications.retain(|app| {
        let field = invalid_field(app).or_else(|| match seen.get(&app["pid"].as_i64()) {
            Some(previous)
                if ["launch_time", "bundle_id", "activation_policy"]
                    .iter()
                    .any(|field| previous[*field] != app[*field]) =>
            {
                Some("duplicate_pid")
            }
            _ => None,
        });
        if let Some(field) = field {
            skipped.push(json!({"pid": app["pid"].as_i64().unwrap_or(0), "field": field}));
            false
        } else {
            seen.insert(app["pid"].as_i64(), app.clone()).is_none()
        }
    });
    if let (Some(pid), Some(time)) = (
        snapshot.get("frontmost_pid"),
        snapshot.get("frontmost_launch_time"),
    ) {
        let invalid_pid = !pid
            .as_i64()
            .is_some_and(|pid| pid >= 0 && i32::try_from(pid).is_ok());
        let invalid_time = !time.is_null()
            && (!time.as_f64().is_some_and(super::valid_launch_time) || pid == &json!(0));
        if invalid_pid || invalid_time {
            skipped.push(json!({"pid":pid.as_i64().unwrap_or(0), "field":if invalid_pid {"frontmost_pid"} else {"frontmost_launch_time"}}));
            snapshot["frontmost_pid"] = json!(0);
            snapshot["frontmost_launch_time"] = Value::Null;
        }
    }
    if !skipped.is_empty() {
        tracing::warn!(skipped = %json!(skipped), "Skipped invalid AppKit application records");
        snapshot["skipped"] = json!(skipped);
    }
    serde_json::from_value(snapshot).map_err(|_| {
        with_skipped(
            inventory_error("AppKit returned invalid workspace identity"),
            &skipped,
        )
    })
}

fn invalid_field(app: &Value) -> Option<&'static str> {
    if !app.is_object() {
        return Some("application_class");
    }
    if !app["pid"]
        .as_i64()
        .is_some_and(|pid| pid > 0 && i32::try_from(pid).is_ok())
    {
        return Some("pid");
    }
    if !app["activation_policy"]
        .as_str()
        .is_some_and(|policy| matches!(policy, "regular" | "accessory" | "prohibited"))
    {
        return Some("activation_policy");
    }
    if !app["name"]
        .as_str()
        .is_some_and(|name| !name.trim().is_empty() && name.len() <= MAX_FIELD_BYTES)
    {
        return Some("application_name");
    }
    if !app
        .get("launch_time")
        .is_some_and(|time| time.is_null() || time.as_f64().is_some_and(super::valid_launch_time))
    {
        return Some("application_launch_time");
    }
    if !app.get("bundle_id").is_none_or(|bundle| {
        bundle.is_null()
            || bundle
                .as_str()
                .is_some_and(|bundle| bundle.len() <= MAX_FIELD_BYTES)
    }) {
        return Some("bundle_identifier");
    }
    None
}

pub(super) fn with_skipped(mut error: AdapterError, skipped: &[Value]) -> AdapterError {
    if !skipped.is_empty() {
        let details = error.details.get_or_insert_with(|| json!({}));
        details["skipped"] = json!(skipped);
    }
    error
}
