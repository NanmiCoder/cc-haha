use agent_desktop_core::{AdapterError, AppInfo, AppInventory, ErrorCode};
use serde::Deserialize;
use std::time::Instant;

const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_FIELD_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActivationPolicy {
    Regular,
    Accessory,
    Prohibited,
}

#[derive(Deserialize)]
struct BridgedApplication {
    name: String,
    pid: i32,
    #[serde(default)]
    bundle_id: Option<String>,
    launch_time: NullableLaunchTime,
    activation_policy: ActivationPolicy,
}

#[derive(Deserialize)]
struct BridgedWorkspaceSnapshot {
    applications: Vec<BridgedApplication>,
    frontmost_pid: i32,
    frontmost_launch_time: NullableLaunchTime,
    #[serde(default)]
    skipped: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct NullableLaunchTime(serde_json::Value);

impl NullableLaunchTime {
    fn value(&self) -> Option<Option<f64>> {
        match &self.0 {
            serde_json::Value::Null => Some(None),
            serde_json::Value::Number(number) => number.as_f64().map(Some),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowOwner {
    pub(crate) pid: i32,
    pub(crate) name: String,
    pub(crate) bundle_id: Option<String>,
    pub(crate) launch_time: Option<f64>,
    pub(crate) activation_policy: ActivationPolicy,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowOwnerSnapshot {
    owners: Vec<WindowOwner>,
    frontmost_pid: Option<i32>,
    skipped: Vec<serde_json::Value>,
}

impl WindowOwnerSnapshot {
    pub(crate) fn eligible_pids(&self) -> rustc_hash::FxHashSet<i32> {
        self.owners.iter().map(|owner| owner.pid).collect()
    }

    pub(crate) fn matching_pids(&self, identifier: &str) -> rustc_hash::FxHashSet<i32> {
        self.owners
            .iter()
            .filter(|owner| {
                agent_desktop_core::app_name_matches(&owner.name, identifier)
                    || owner
                        .bundle_id
                        .as_deref()
                        .is_some_and(|bundle_id| bundle_id.eq_ignore_ascii_case(identifier))
            })
            .map(|owner| owner.pid)
            .collect()
    }

    pub(crate) fn require_match(&self, identifier: &str) -> Result<(), AdapterError> {
        if self.matching_pids(identifier).is_empty() {
            require_complete(&self.skipped)?;
        }
        Ok(())
    }

    pub(crate) fn owner(&self, pid: i32) -> Option<&WindowOwner> {
        self.owners.iter().find(|owner| owner.pid == pid)
    }

    pub(crate) fn frontmost(&self) -> Option<&WindowOwner> {
        self.frontmost_pid.and_then(|pid| self.owner(pid))
    }

    pub(crate) fn same_generation(&self, other: &Self) -> bool {
        self == other
    }
}

pub(crate) fn list_apps_inventory_until(deadline: Instant) -> Result<AppInventory, AdapterError> {
    #[cfg(test)]
    if let Some(inventory) = crate::system::app::app_inventory::adapter_tests::workspace_inventory()
    {
        return Ok(inventory);
    }
    list_apps_with(deadline, |_| true, true)
}

pub(crate) fn require_complete(skipped: &[serde_json::Value]) -> Result<(), AdapterError> {
    if skipped.is_empty() {
        return Ok(());
    }
    Err(records::with_skipped(
        inventory_error("AppKit application inventory skipped records"),
        skipped,
    ))
}

pub(crate) fn list_apps_scoped_until(
    name: &str,
    bundle_id: Option<&str>,
    deadline: Instant,
) -> Result<AppInventory, AdapterError> {
    list_apps_with(
        deadline,
        |app| {
            (agent_desktop_core::app_name_matches(&app.name, name)
                || (bundle_id.is_none()
                    && app
                        .bundle_id
                        .as_deref()
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))))
                && bundle_id.is_none_or(|bundle| {
                    app.bundle_id
                        .as_deref()
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(bundle))
                })
        },
        false,
    )
}

pub(crate) fn window_owner_snapshot_until(
    deadline: Instant,
) -> Result<WindowOwnerSnapshot, AdapterError> {
    ensure_before_deadline(deadline)?;
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded()?;
    let bytes = crate::system::appkit_bridge::workspace_snapshot_json()?;
    ensure_before_deadline(deadline)?;
    window_owner_snapshot_from_json(&bytes, deadline)
}

fn list_apps_with(
    deadline: Instant,
    include: impl Fn(&BridgedApplication) -> bool,
    skip_cross_uid: bool,
) -> Result<AppInventory, AdapterError> {
    ensure_before_deadline(deadline)?;
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded()?;
    let bytes = crate::system::appkit_bridge::workspace_snapshot_json()?;
    ensure_before_deadline(deadline)?;
    apps_inventory_from_json_with(
        &bytes,
        deadline,
        include,
        skip_cross_uid,
        crate::system::process::process_identity::token_for_pid,
    )
}

#[cfg(test)]
fn apps_from_json(bytes: &[u8], deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    apps_from_json_with(
        bytes,
        deadline,
        |_| true,
        true,
        crate::system::process::process_identity::token_for_pid,
    )
}

#[cfg(test)]
fn apps_from_json_with(
    bytes: &[u8],
    deadline: Instant,
    include: impl Fn(&BridgedApplication) -> bool,
    skip_cross_uid: bool,
    resolve: impl FnMut(i32) -> Result<Option<String>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    Ok(apps_inventory_from_json_with(bytes, deadline, include, skip_cross_uid, resolve)?.apps)
}

fn apps_inventory_from_json_with(
    bytes: &[u8],
    deadline: Instant,
    include: impl Fn(&BridgedApplication) -> bool,
    skip_cross_uid: bool,
    mut resolve: impl FnMut(i32) -> Result<Option<String>, AdapterError>,
) -> Result<AppInventory, AdapterError> {
    let bridged = bridged_snapshot(bytes)?;
    let mut apps = Vec::with_capacity(bridged.applications.len());
    for app in bridged
        .applications
        .into_iter()
        .filter(|app| app.activation_policy != ActivationPolicy::Prohibited)
        .filter(include)
    {
        ensure_before_deadline(deadline)
            .map_err(|error| records::with_skipped(error, &bridged.skipped))?;
        let process_instance = match resolve(app.pid) {
            Ok(Some(instance)) => instance,
            Ok(None) => {
                return Err(records::with_skipped(
                    inventory_error("Selected application exited during inventory"),
                    &bridged.skipped,
                ));
            }
            Err(error)
                if skip_cross_uid
                    && crate::system::process::process_apps::is_cross_uid_identity_error(
                        &error,
                    ) =>
            {
                continue;
            }
            Err(error) => return Err(records::with_skipped(error, &bridged.skipped)),
        };
        apps.push(AppInfo {
            name: app.name,
            pid: crate::system::process::process_identity::from_pid_t(app.pid)?,
            bundle_id: app.bundle_id,
            process_instance: Some(process_instance),
            presentation: Some(presentation_of(app.activation_policy)),
        });
    }
    ensure_before_deadline(deadline)
        .map_err(|error| records::with_skipped(error, &bridged.skipped))?;
    Ok(AppInventory {
        apps,
        skipped: bridged.skipped,
    })
}

fn presentation_of(policy: ActivationPolicy) -> agent_desktop_core::AppPresentation {
    match policy {
        ActivationPolicy::Regular => agent_desktop_core::AppPresentation::Foreground,
        ActivationPolicy::Accessory | ActivationPolicy::Prohibited => {
            agent_desktop_core::AppPresentation::Background
        }
    }
}

fn window_owner_snapshot_from_json(
    bytes: &[u8],
    deadline: Instant,
) -> Result<WindowOwnerSnapshot, AdapterError> {
    let bridged = bridged_snapshot(bytes)?;
    let mut owners = Vec::with_capacity(bridged.applications.len());
    for app in bridged
        .applications
        .into_iter()
        .filter(|app| app.activation_policy != ActivationPolicy::Prohibited)
    {
        ensure_before_deadline(deadline)
            .map_err(|error| records::with_skipped(error, &bridged.skipped))?;
        let Some(launch_time) = app.launch_time.value() else {
            return Err(inventory_error(
                "AppKit returned invalid window-owner identity",
            ));
        };
        owners.push(WindowOwner {
            pid: app.pid,
            name: app.name,
            bundle_id: app.bundle_id,
            launch_time,
            activation_policy: app.activation_policy,
        });
    }
    owners.sort_unstable_by_key(|owner| owner.pid);
    let Some(frontmost_launch_time) = bridged.frontmost_launch_time.value() else {
        return Err(inventory_error(
            "AppKit returned incomplete frontmost-application identity",
        ));
    };
    let frontmost_pid = if bridged
        .skipped
        .iter()
        .any(|record| record["pid"].as_i64() == Some(i64::from(bridged.frontmost_pid)))
        && !owners
            .iter()
            .any(|owner| owner.pid == bridged.frontmost_pid)
    {
        None
    } else {
        validate_frontmost(&mut owners, bridged.frontmost_pid, frontmost_launch_time)
            .map_err(|error| records::with_skipped(error, &bridged.skipped))?
    };
    ensure_before_deadline(deadline)
        .map_err(|error| records::with_skipped(error, &bridged.skipped))?;
    Ok(WindowOwnerSnapshot {
        owners,
        frontmost_pid,
        skipped: bridged.skipped,
    })
}

fn validate_frontmost(
    owners: &mut [WindowOwner],
    pid: i32,
    launch_time: Option<f64>,
) -> Result<Option<i32>, AdapterError> {
    if pid == 0 && launch_time.is_none() {
        return Ok(None);
    }
    if pid <= 0 || launch_time.is_some_and(|value| !valid_launch_time(value)) {
        return Err(inventory_error(
            "AppKit returned incomplete frontmost-application identity",
        ));
    }
    let Some(owner) = owners.iter_mut().find(|owner| owner.pid == pid) else {
        return Err(inventory_error(
            "AppKit frontmost application did not exactly match an eligible window owner",
        ));
    };
    match (owner.launch_time, launch_time) {
        (Some(owner_launch_time), Some(frontmost_launch_time))
            if owner_launch_time.to_bits() != frontmost_launch_time.to_bits() =>
        {
            return Err(inventory_error(
                "AppKit frontmost application did not exactly match an eligible window owner",
            ));
        }
        (None, Some(frontmost_launch_time)) => {
            owner.launch_time = Some(frontmost_launch_time);
        }
        _ => {}
    }
    Ok(Some(pid))
}

fn valid_launch_time(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::timeout("NSWorkspace app inventory timed out"));
    }
    Ok(())
}

fn inventory_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::AppUnresponsive, message)
        .with_suggestion("Retry after macOS finishes updating the running-application inventory")
        .with_details(serde_json::json!({
            "kind": "inventory_source",
            "source": "ns_workspace",
            "complete": false,
            "retryable": true,
        }))
}

#[cfg(test)]
#[path = "workspace_apps_pid_tests.rs"]
mod pid_tests;

#[cfg(test)]
#[path = "workspace_apps_tests.rs"]
mod tests;

#[path = "workspace_apps_records.rs"]
mod records;
use records::bridged_snapshot;

#[cfg(test)]
#[path = "workspace_apps_skip_tests.rs"]
mod skip_tests;
