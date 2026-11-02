use super::*;
use agent_desktop_core::{AccessibilityNode, AdapterError, ErrorCode};
use clap::Parser;
use std::io::Write;

fn command(args: &[&str]) -> Commands {
    crate::Cli::try_parse_from(std::iter::once("agent-desktop").chain(args.iter().copied()))
        .unwrap()
        .command
        .unwrap()
}

fn output_path() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "agent-desktop-debug-test-{}-{}.html",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

#[test]
fn visual_debug_validation_rejects_unsupported_commands_surfaces_and_extensions() {
    let mut options = DebugOptions {
        verbose: false,
        debug: true,
        screenshot: Some(output_path()),
    };
    for args in [
        vec!["version"],
        vec!["batch", "[]"],
        vec!["snapshot", "--surface", "menu"],
    ] {
        assert!(options.validate(&command(&args)).is_err());
    }
    assert!(
        options
            .validate(&command(&["snapshot", "--skeleton", "-i"]))
            .is_ok()
    );
    options.screenshot = Some(PathBuf::from("capture.png"));
    assert!(options.validate(&command(&["snapshot"])).is_err());
}

#[test]
fn visual_debug_disabled_does_not_change_snapshot_or_use_adapter() {
    let mut cmd = command(&["snapshot", "--compact"]);
    let prepared = DebugCapture::prepare(
        &mut cmd,
        &DebugOptions::default(),
        &crate::test_noop_ops::NoopAdapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert!(prepared.is_none());
    let Commands::Snapshot(args) = cmd else {
        panic!()
    };
    assert!(!args.tree.include_bounds);
    assert!(args.tree.compact);
}

#[test]
fn visual_debug_nodes_distinguish_anchors_actions_and_context() {
    let tree: AccessibilityNode = serde_json::from_value(json!({
        "role": "window", "children": [
            {"role":"group", "ref_id":"@sdemo:e1", "name":"Sidebar", "children_count":20, "available_actions":["SetFocus"]},
            {"role":"group", "ref_id":"@sdemo:e4", "name":"Board", "children_count":9, "available_actions":["RightClick","ScrollTo"]},
            {"role":"button", "ref_id":"@sdemo:e2", "name":"Save"},
            {"role":"scrollarea", "ref_id":"@sdemo:e3", "available_actions":["Scroll"]},
            {"role":"group", "children":[{"role":"statictext", "name":"Context"}]}
        ]
    })).unwrap();
    let mut nodes = Vec::new();
    capture::collect_nodes(&tree, 0, &mut nodes);
    assert_eq!(nodes.len(), 7);
    assert_eq!(nodes[0]["kind"], "root");
    assert_eq!(nodes[1]["kind"], "drill");
    assert_eq!(nodes[1]["children_count"], 20);
    assert_eq!(nodes[2]["kind"], "drill");
    assert_eq!(nodes[3]["kind"], "action");
    assert_eq!(nodes[4]["kind"], "action");
    assert_eq!(nodes[5]["kind"], "context");
    assert_eq!(nodes[6]["depth"], 2);
}

#[test]
fn visual_debug_html_escapes_app_controlled_content() {
    let payload = json!({"name":"</script><script>alert(1)</script>&\u{2028}", "value":"{{JS}}"});
    let html = render::html(&payload).unwrap();
    assert!(!html.contains("<script>alert(1)</script>"));
    assert!(html.contains("\\u003c/script\\u003e"));
    assert!(html.contains("connect-src 'none'"));
    let island = html
        .split("<script id=\"debug-data\" type=\"application/json\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(island).unwrap(), payload);
}

#[test]
fn visual_debug_post_capture_failure_preserves_success_and_compact_output() {
    let path = output_path();
    let options = DebugOptions {
        verbose: false,
        debug: true,
        screenshot: Some(path.clone()),
    };
    let mut cmd = command(&["snapshot", "--compact"]);
    let adapter = crate::test_noop_ops::NoopAdapter;
    let capture = DebugCapture::prepare(&mut cmd, &options, &adapter, &CommandContext::default())
        .unwrap()
        .unwrap();
    let mut result = Ok(
        json!({"tree":{"role":"window","bounds":{"x":1},"children":[{"role":"button","bounds":{"x":2}}]}}),
    );
    capture.finish(&mut result, &adapter, &CommandContext::default());
    let data = result.unwrap();
    assert!(data["debug"]["warning"].is_string());
    assert!(data["tree"].get("bounds").is_none());
    assert!(data["tree"]["children"][0].get("bounds").is_none());
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("Screenshot unavailable")
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn visual_debug_never_overwrites_existing_artifact() {
    let path = output_path();
    std::fs::File::create_new(&path)
        .unwrap()
        .write_all("keep".as_ref())
        .unwrap();
    let options = DebugOptions {
        verbose: false,
        debug: true,
        screenshot: Some(path.clone()),
    };
    assert!(
        DebugCapture::prepare(
            &mut command(&["snapshot"]),
            &options,
            &crate::test_noop_ops::NoopAdapter,
            &CommandContext::default()
        )
        .is_err()
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn visual_debug_command_failure_preserves_error_disposition() {
    let path = output_path();
    let options = DebugOptions {
        verbose: false,
        debug: true,
        screenshot: Some(path.clone()),
    };
    let adapter = crate::test_noop_ops::NoopAdapter;
    let capture = DebugCapture::prepare(
        &mut command(&["snapshot"]),
        &options,
        &adapter,
        &CommandContext::default(),
    )
    .unwrap()
    .unwrap();
    let mut result = Err(AppError::from(AdapterError::new(
        ErrorCode::ActionFailed,
        "Original failure",
    )));
    capture.finish(&mut result, &adapter, &CommandContext::default());
    assert_eq!(result.unwrap_err().code(), "ACTION_FAILED");
    std::fs::remove_file(path).unwrap();
}
