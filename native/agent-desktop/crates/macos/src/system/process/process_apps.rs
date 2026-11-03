use agent_desktop_core::{AdapterError, AppInfo, ErrorCode};
use std::{process::Output, time::Instant};

pub(crate) fn list_apps_until(deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    #[cfg(test)]
    if crate::system::app::app_inventory::adapter_tests::workspace_inventory().is_some() {
        return Ok(Vec::new());
    }
    list_apps_with_filter(None, deadline)
}

pub(crate) fn list_apps_scoped_until(
    name: &str,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    list_apps_with_filter(Some(name), deadline)
}

fn list_apps_with_filter(
    name: Option<&str>,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::timeout("ps app inventory timed out"));
    }
    let mut command = std::process::Command::new("/bin/ps");
    command.args(["-axo", "pid=,comm="]);
    let output = crate::system::process::run_with_deadline(&mut command, "ps", deadline)?;
    let mut apps = apps_from_output(output)?;
    apps.retain(|app| {
        name.is_none_or(|name| agent_desktop_core::app_name_matches(&app.name, name))
    });
    enrich_process_instances(
        apps,
        crate::system::process::process_identity::token_for_pid,
    )
}

fn enrich_process_instances(
    apps: Vec<AppInfo>,
    mut resolve: impl FnMut(i32) -> Result<Option<String>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    let mut enriched = Vec::with_capacity(apps.len());
    for mut app in apps {
        let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
        app.process_instance = match resolve(pid) {
            Ok(Some(instance)) => Some(instance),
            Ok(None) => continue,
            Err(error) if is_cross_uid_identity_error(&error) => continue,
            Err(error) => return Err(error),
        };
        enriched.push(app);
    }
    Ok(enriched)
}

pub(crate) fn is_cross_uid_identity_error(error: &AdapterError) -> bool {
    error.code == ErrorCode::PermDenied
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("process_identity_permission")
}

fn apps_from_output(output: Output) -> Result<Vec<AppInfo>, AdapterError> {
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(inventory_error(
            format!("ps app inventory exited with {}", output.status),
            detail,
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|error| {
        inventory_error(
            "ps app inventory returned non-UTF-8 output".to_string(),
            error.to_string(),
        )
    })?;
    parse_apps(&text)
}

fn parse_apps(text: &str) -> Result<Vec<AppInfo>, AdapterError> {
    let mut seen_pids = rustc_hash::FxHashSet::default();
    let mut apps = Vec::new();

    for line in text.lines() {
        let line = line.trim_start();
        if line.is_empty() {
            continue;
        }
        let mut fields = line.splitn(2, char::is_whitespace);
        let pid_text = fields.next().ok_or_else(malformed_output)?;
        let command = fields
            .next()
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .ok_or_else(malformed_output)?;
        let pid = pid_text.parse::<i32>().map_err(|_| malformed_output())?;
        if pid <= 0 {
            return Err(malformed_output());
        }
        let Some(name) = app_name_from_command(command) else {
            if command.contains(".app/Contents/MacOS")
                && !command.contains("/Contents/Frameworks/")
                && !command.contains("/Contents/PlugIns/")
            {
                return Err(malformed_output());
            }
            continue;
        };
        if seen_pids.insert(pid) {
            apps.push(AppInfo {
                name,
                pid: crate::system::process::process_identity::from_pid_t(pid)?,
                bundle_id: None,
                process_instance: None,
                presentation: None,
            });
        }
    }

    Ok(apps)
}

fn malformed_output() -> AdapterError {
    inventory_error(
        "ps app inventory returned malformed output".to_string(),
        "expected one positive pid and executable path per line".to_string(),
    )
}

fn inventory_error(message: String, detail: String) -> AdapterError {
    AdapterError::new(ErrorCode::AppUnresponsive, message)
        .with_suggestion("Retry after macOS finishes updating the process inventory")
        .with_platform_detail(detail)
        .with_details(serde_json::json!({
            "kind": "inventory_source",
            "source": "ps",
            "retryable": true,
        }))
}

fn app_name_from_command(command: &str) -> Option<String> {
    if command.contains("/Contents/Frameworks/")
        || command.contains("/Contents/PlugIns/")
        || command.contains("/XPCServices/")
        || command.contains(".appex/")
    {
        return None;
    }

    let marker = ".app/Contents/MacOS";
    let marker_start = command.find(marker)?;
    let app_path = &command[..marker_start + ".app".len()];
    let app_name = app_path.rsplit('/').next()?.strip_suffix(".app")?;
    if app_name.is_empty() {
        None
    } else {
        Some(app_name.to_string())
    }
}

#[cfg(test)]
#[path = "process_apps_tests.rs"]
mod tests;
