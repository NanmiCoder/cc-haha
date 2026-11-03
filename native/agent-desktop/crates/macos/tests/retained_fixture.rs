#![cfg(target_os = "macos")]

use agent_desktop_core::{
    Deadline, IdentityPredicate, LocatorMaterialization, LocatorQuery, LocatorResolveRequest,
    LocatorSelection, ObservationOps, ObservationRoot, RefEntry, WindowFilter, resolve_query,
};
use agent_desktop_macos::{MacOSAdapter, RetainedRefSession};
use std::io::{BufRead, Write};

fn capture(
    adapter: &MacOSAdapter,
    window: &agent_desktop_core::WindowInfo,
    id: &str,
    value: &str,
) -> RefEntry {
    let resolution = resolve_query(
        adapter,
        &LocatorQuery {
            identity: IdentityPredicate {
                role: Some("textfield".into()),
                native_id: Some(id.into()),
                value: Some(value.into()),
                ..Default::default()
            },
            exact: true,
            ..Default::default()
        },
        ObservationRoot::Window(window),
        &LocatorResolveRequest {
            selection: LocatorSelection::First,
            deadline: Deadline::after(5000).unwrap(),
            max_raw_depth: 50,
            materialization: LocatorMaterialization::SelectedMatches,
            surface: None,
        },
    )
    .unwrap();
    assert_eq!(resolution.matches.len(), 1);
    let ref_id = resolution.matches[0].data.ref_id.as_deref().unwrap();
    let entry = resolution
        .refmap
        .as_ref()
        .unwrap()
        .get(ref_id)
        .unwrap()
        .clone();
    assert!(entry.identity.retained_object.is_some());
    entry
}

fn read(
    adapter: &MacOSAdapter,
    entry: &RefEntry,
) -> Result<Option<String>, agent_desktop_core::ErrorCode> {
    let deadline = Deadline::after(5000).unwrap();
    let handle = adapter
        .resolve_element_strict(entry, deadline)
        .map_err(|error| error.code)?;
    let live = adapter
        .get_live_element(&handle, deadline)
        .map_err(|error| error.code)?;
    assert_eq!(
        live.identity.identifiers.retained_object(),
        entry.identity.retained_object.as_deref()
    );
    Ok(live.state.value)
}

#[test]
#[ignore = "read-only Xcode identity diagnostic; requires stage labels on stdin"]
fn retained_xcode_identity() {
    let window_id = std::env::var("AGENT_DESKTOP_TEST_WINDOW").unwrap();
    let _owner = RetainedRefSession::start().unwrap();
    let adapter = MacOSAdapter::new();
    let windows = adapter
        .list_windows(
            &WindowFilter {
                app: Some("Xcode".into()),
                ..Default::default()
            },
            Deadline::after(5000).unwrap(),
        )
        .unwrap();
    let window = windows
        .iter()
        .find(|window| window.id == window_id)
        .unwrap();
    let original = capture(&adapter, window, "title", "cursorcamapp.swift");
    println!("ready: adapter retained original Xcode file label");
    std::io::stdout().flush().unwrap();
    let mut stages = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let stage = line.unwrap();
        if stage == "quit" {
            break;
        }
        let value = read(&adapter, &original);
        println!("stage={stage} original={value:?}");
        match stage.as_str() {
            "initial" => assert_eq!(value, Ok(Some("CursorCamApp.swift".into()))),
            "filtered" => assert_eq!(value, Err(agent_desktop_core::ErrorCode::StaleRef)),
            "restored" => assert!(
                value == Ok(Some("CursorCamApp.swift".into()))
                    || value == Err(agent_desktop_core::ErrorCode::StaleRef)
            ),
            _ => panic!("Unexpected diagnostic stage"),
        }
        stages.push(stage);
        std::io::stdout().flush().unwrap();
    }
    assert_eq!(stages, ["initial", "filtered", "restored"]);
}

#[test]
#[ignore = "read-only adapter diagnostic; requires owned RefChurnView and stage labels on stdin"]
fn retained_fixture_identity() {
    let window_id = std::env::var("AGENT_DESKTOP_TEST_WINDOW").unwrap();
    let owner = RetainedRefSession::start().unwrap();
    let adapter = MacOSAdapter::new();
    let windows = adapter
        .list_windows(
            &WindowFilter {
                app: Some("AgentDeskFixture".into()),
                ..Default::default()
            },
            Deadline::after(5000).unwrap(),
        )
        .unwrap();
    let window = windows
        .iter()
        .find(|window| window.id == window_id)
        .unwrap();
    let alpha = capture(&adapter, window, "shared-title", "alpha");
    let stable = capture(&adapter, window, "stable-editor", "stable value");
    println!("ready: adapter retained Alpha and stable editor");
    std::io::stdout().flush().unwrap();
    let mut stages = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let stage = line.unwrap();
        if stage == "quit" {
            break;
        }
        let alpha_value = read(&adapter, &alpha);
        let stable_value = read(&adapter, &stable);
        println!("stage={stage} alpha={alpha_value:?} stable={stable_value:?}");
        if stage == "initial" {
            assert_eq!(alpha_value, Ok(Some("Alpha".into())));
        } else {
            assert_eq!(alpha_value, Err(agent_desktop_core::ErrorCode::StaleRef));
        }
        let expected = if stage == "edited" {
            "retained-control"
        } else {
            "Stable value"
        };
        assert_eq!(stable_value, Ok(Some(expected.into())));
        stages.push(stage);
        std::io::stdout().flush().unwrap();
    }
    assert_eq!(
        stages,
        ["initial", "filtered", "restored", "edited", "cleared"]
    );
    drop(owner);
    assert_eq!(
        read(&adapter, &stable),
        Err(agent_desktop_core::ErrorCode::StaleRef)
    );
}
