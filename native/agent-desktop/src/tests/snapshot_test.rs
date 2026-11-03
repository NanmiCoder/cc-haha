#[cfg(test)]
mod tests {
    use std::process::Command;

    fn run(args: &[&str]) -> serde_json::Value {
        let output = Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
            .args(args)
            .output()
            .expect("failed to run agent-desktop");
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "agent-desktop output is not JSON: {error}; stderr={}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }

    #[cfg(target_os = "macos")]
    fn first_finder_window_id() -> String {
        let list = run(&["list-windows", "--app", "Finder"]);
        list["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|window| window["id"].as_str())
            .unwrap_or_else(|| {
                panic!(
                    "precondition not met: Finder reports no windows; open a Finder window and rerun with --ignored: {list}"
                )
            })
            .to_owned()
    }

    #[cfg(target_os = "macos")]
    fn role_path(found: &serde_json::Value) -> Vec<&str> {
        found["path"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|step| step.as_str()?.split(':').next())
            .collect()
    }

    /// Guards the native AX-to-CG window identity bridge used by snapshots.
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires Accessibility permissions and running macOS apps"]
    fn snapshot_resolves_a_window_id_reported_by_list_windows() {
        let window_id = first_finder_window_id();

        let snapshot = run(&["snapshot", "--app", "Finder", "--window-id", &window_id]);
        assert_eq!(
            snapshot["ok"], true,
            "snapshot must resolve a window id reported by list-windows, got error {}",
            snapshot["error"]["code"]
        );
        assert_eq!(
            snapshot["data"]["window"]["id"].as_str(),
            Some(window_id.as_str()),
            "snapshot must resolve the window it was asked for"
        );
    }

    /// Guards consistent accessible-name computation across snapshot and find.
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires Accessibility permissions and running macOS apps"]
    fn find_by_name_matches_the_element_that_reports_that_name() {
        let window_id = first_finder_window_id();
        let buttons = run(&[
            "find",
            "--app",
            "Finder",
            "--window-id",
            &window_id,
            "--role",
            "button",
        ]);
        let named = buttons["data"]["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|button| {
                button["name"]
                    .as_str()
                    .is_some_and(|name| !name.is_empty() && !name.starts_with("(unnamed"))
            })
            .unwrap_or_else(|| {
                panic!(
                    "precondition not met: Finder window {window_id} exposes no named button; open a Finder window with a toolbar and rerun with --ignored: {buttons}"
                )
            });
        let name = named["name"].as_str().unwrap_or_default();

        let by_name = run(&[
            "find",
            "--app",
            "Finder",
            "--window-id",
            &window_id,
            "--role",
            "button",
            "--name",
            name,
            "--first",
        ]);
        assert_eq!(
            role_path(&by_name["data"]["match"]),
            role_path(named),
            "find --name {name:?} must resolve the element that reported that name"
        );
    }

    /// Guards strict identity re-resolution for a freshly produced ref.
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires Accessibility permissions and running macOS apps"]
    fn a_ref_from_find_reresolves_through_get() {
        let window_id = first_finder_window_id();
        let found = run(&[
            "find",
            "--app",
            "Finder",
            "--window-id",
            &window_id,
            "--role",
            "button",
            "--first",
        ]);
        let Some(ref_id) = found["data"]["match"]["ref_id"].as_str() else {
            panic!(
                "precondition not met: Finder exposes no button; open a Finder window and rerun with --ignored: {found}"
            );
        };

        let got = run(&["get", ref_id, "--property", "role"]);
        assert_eq!(
            got["ok"], true,
            "a ref from find must re-resolve through get, got error {}",
            got["error"]["code"]
        );
    }

    #[test]
    fn real_app_regression_gate_stays_registered() {
        let source = include_str!("snapshot_test.rs");
        assert_eq!(source.matches(concat!("#[", "ignore =")).count(), 3);
        for name in [
            "snapshot_resolves_a_window_id_reported_by_list_windows",
            "find_by_name_matches_the_element_that_reports_that_name",
            "a_ref_from_find_reresolves_through_get",
        ] {
            assert!(source.contains(&format!("fn {name}()")));
        }
    }

    #[test]
    fn snapshot_invalid_root_ref_format_returns_invalid_args() {
        let json = run(&["snapshot", "--app", "Finder", "--root", "bad-ref"]);
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["code"], "INVALID_ARGS");
    }

    #[test]
    fn list_apps_inventory_matches_the_platform() {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let json = run(&["list-apps"]);
            assert_eq!(
                json["ok"], true,
                "list-apps is live on this platform: {json}"
            );
            assert!(
                json["data"]["apps"].is_array(),
                "list-apps returns an apps array on this platform: {json}"
            );
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let json = run(&["list-apps"]);
            if json["ok"] == true {
                assert!(
                    json["data"]["apps"].is_array(),
                    "list-apps returns an apps array on Linux"
                );
            } else {
                assert_eq!(
                    json["error"]["code"], "PLATFORM_NOT_SUPPORTED",
                    "the only failure a session without a bus may report: {json}"
                );
                let message = json["error"]["message"].as_str().unwrap_or_default();
                assert!(
                    message.contains("AT-SPI accessibility bus is not available"),
                    "the failure names the missing bus: {json}"
                );
            }
        }
    }
}
