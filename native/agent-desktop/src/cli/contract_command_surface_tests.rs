use crate::cli::Cli;
use clap::CommandFactory;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const NON_COMMAND_MODULES: &[&str] = &[
    "combo",
    "execute_by_ref",
    "find_live",
    "helpers",
    "helpers_test_support",
    "input_hold_policy",
    "launch_cdp_test_support",
    "mod",
    "notification_identity",
    "notification_policy",
    "operation_response",
    "point_resolve",
    "pointer_action",
    "query",
    "find_live_test_support",
    "surface_scope",
    "type_text_interval",
    "type_text_interval_verify",
    "stale_retry_test_support",
    "wait_element",
    "wait_latest_ref_cache",
    "wait_mode",
    "wait_notification",
    "wait_predicate",
    "wait_scheduler",
    "wait_surface",
    "wait_test_support",
    "wait_text_match",
    "wait_timeout",
    "wait_event",
    "wait_event_filter",
    "wait_event_input",
    "wait_selector",
    "window_target",
];

const COMMAND_SPECIFIC_TESTS: &[&str] = &[
    "cursor-overlay",
    "find",
    "focus-window",
    "is",
    "list-apps",
    "right-click",
    "skills",
    "session",
    "snapshot",
    "status",
    "trace",
    "wait",
];

const SHARED_REF_ACTION_TESTS: &[&str] = &[
    "check",
    "clear",
    "click",
    "collapse",
    "double-click",
    "expand",
    "focus",
    "right-click",
    "scroll",
    "scroll-to",
    "select",
    "set-value",
    "toggle",
    "triple-click",
    "type",
    "uncheck",
];

const BINARY_CONTRACT_TESTS: &[&str] = &["batch", "permissions", "version"];

const ADAPTER_PASSTHROUGH_COMMANDS: &[&str] = &[
    "clipboard-clear",
    "clipboard-get",
    "clipboard-set",
    "close-app",
    "dismiss-all-notifications",
    "dismiss-notification",
    "drag",
    "get",
    "hover",
    "key-down",
    "key-up",
    "launch",
    "list-notifications",
    "list-surfaces",
    "list-windows",
    "list-displays",
    "maximize",
    "minimize",
    "mouse-click",
    "mouse-down",
    "mouse-move",
    "mouse-up",
    "mouse-wheel",
    "move-window",
    "notification-action",
    "open-system-surface",
    "press",
    "resize-window",
    "restore",
    "screenshot",
];

#[test]
fn every_cli_subcommand_has_core_command_module() {
    for command in cli_command_names() {
        let module = command_module_name(&command);
        let path = command_module_path(&module);
        assert!(
            path.exists(),
            "{command} is missing core command module {path:?}"
        );
    }
}

#[test]
fn every_core_command_module_is_registered_or_declared_helper() {
    let command_modules: BTreeSet<_> = cli_command_names()
        .into_iter()
        .map(|name| command_module_name(&name))
        .collect();

    for module in command_module_files() {
        if module.ends_with("_tests") {
            continue;
        }
        assert!(
            command_modules.contains(module.as_str())
                || NON_COMMAND_MODULES.contains(&module.as_str()),
            "{module}.rs is not registered as a CLI command module or declared helper"
        );
    }
}

#[test]
fn every_cli_subcommand_has_explicit_test_coverage_classification() {
    let covered = coverage_names();
    for command in cli_command_names() {
        assert!(
            covered.contains(command.as_str()),
            "{command} has no explicit command coverage classification"
        );
    }
}

#[test]
fn macos_capability_count_includes_restored_notifications() {
    let commands = cli_command_names();
    assert_eq!(
        commands.len(),
        60,
        "the published CLI command count changed; update capability documentation"
    );
}

#[test]
fn core_command_modules_keep_tests_in_sibling_files() {
    for path in command_module_paths() {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem.ends_with("_tests") || NON_COMMAND_MODULES.contains(&stem) {
            continue;
        }

        let source = std::fs::read_to_string(&path).expect("command module should be readable");
        assert!(
            !source.contains("mod tests {"),
            "{} keeps inline tests; move them to {stem}_tests.rs and include with #[path]",
            path.display()
        );
    }
}

fn cli_command_names() -> Vec<String> {
    Cli::command()
        .get_subcommands()
        .map(|cmd| cmd.get_name().to_owned())
        .collect()
}

fn command_module_name(command: &str) -> String {
    match command {
        "is" => "is_check".into(),
        "type" => "type_text".into(),
        other => other.replace('-', "_"),
    }
}

fn command_module_path(module: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/core/src/commands")
        .join(format!("{module}.rs"))
}

fn command_module_files() -> Vec<String> {
    let mut files: Vec<String> = command_module_paths()
        .into_iter()
        .filter_map(|path| path.file_stem().map(|stem| stem.to_owned()))
        .filter_map(|stem| stem.to_str().map(ToOwned::to_owned))
        .collect();
    files.sort();
    files
}

fn command_module_paths() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/core/src/commands");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("command module directory exists")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .collect();
    paths.sort();
    paths
}

fn coverage_names() -> BTreeSet<&'static str> {
    COMMAND_SPECIFIC_TESTS
        .iter()
        .chain(SHARED_REF_ACTION_TESTS)
        .chain(BINARY_CONTRACT_TESTS)
        .chain(ADAPTER_PASSTHROUGH_COMMANDS)
        .copied()
        .collect()
}

#[path = "windows_capability_claims_tests.rs"]
mod windows_capability_claims;

#[path = "doc_literal_drift_tests.rs"]
mod doc_literal_drift;

#[test]
fn listing_timeout_is_accepted_in_cli_and_batch() {
    use clap::Parser;
    for command in ["list-apps", "list-windows"] {
        let cli = crate::cli::Cli::try_parse_from(["agent-desktop", command, "--timeout-ms", "37"])
            .unwrap();
        let batch =
            crate::batch::parse_command(agent_desktop_core::commands::batch::BatchCommand {
                command: command.into(),
                session: None,
                args: serde_json::json!({"timeout_ms":37}),
            });
        for parsed in [cli.command.unwrap(), batch.unwrap()] {
            match &parsed {
                crate::cli::Commands::ListApps(args) => assert_eq!(args.timeout_ms, Some(37)),
                crate::cli::Commands::ListWindows(args) => assert_eq!(args.timeout_ms, Some(37)),
                _ => panic!("listing command"),
            }
            crate::dispatch::dispatch(
                parsed,
                &ListingDeadlineAdapter,
                &agent_desktop_core::PermissionReport::default(),
                &agent_desktop_core::context::CommandContext::default(),
            )
            .unwrap();
        }
    }
}

struct ListingDeadlineAdapter;

impl agent_desktop_core::ObservationOps for ListingDeadlineAdapter {
    fn list_apps(
        &self,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<Vec<agent_desktop_core::AppInfo>, agent_desktop_core::AdapterError> {
        assert_eq!(deadline.timeout_ms(), 37);
        Ok(Vec::new())
    }
    fn list_windows(
        &self,
        _: &agent_desktop_core::WindowFilter,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<Vec<agent_desktop_core::WindowInfo>, agent_desktop_core::AdapterError> {
        assert_eq!(deadline.timeout_ms(), 37);
        Ok(Vec::new())
    }
}
impl agent_desktop_core::ActionOps for ListingDeadlineAdapter {}
impl agent_desktop_core::InputOps for ListingDeadlineAdapter {}
impl agent_desktop_core::SystemOps for ListingDeadlineAdapter {}
