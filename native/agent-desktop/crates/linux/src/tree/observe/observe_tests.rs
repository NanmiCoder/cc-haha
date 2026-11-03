use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ObservationRequest, ObservationRoot, SnapshotSurface,
    TreeOptions, WindowInfo, WindowState,
};

use super::{SettleHost, observe_with, refuse_stopped};
use crate::system::window::window_id;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::walk::walker::walk_levels;
use crate::tree::walk::wrapper::classify;
use crate::tree::{AtspiElement, Expansion, Field, ObservedRead, Walk, WalkLimits};

pub(super) fn observe_plain(
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
    mut walker: impl FnMut(
        &AtspiElement,
        &WalkLimits,
        Deadline,
    ) -> Result<Walk<ObservedRead>, AdapterError>,
) -> Result<agent_desktop_core::ObservedTree, AdapterError> {
    observe_with(
        root,
        request,
        SettleHost {
            walker: &mut |element, limits, deadline, _| walker(element, limits, deadline),
            place: &mut |_| Ok(()),
            is_web_process: &|_| Ok(false),
            stopped: &|_| false,
            pause: &mut |_| {},
        },
    )
}

pub(super) fn window(id: String) -> WindowInfo {
    WindowInfo {
        id,
        title: "t".to_owned(),
        app: "a".to_owned(),
        pid: 77.into(),
        process_instance: Some("i".to_owned()),
        bounds: None,
        state: WindowState::default(),
    }
}

pub(super) fn request() -> ObservationRequest {
    ObservationRequest::snapshot(
        &TreeOptions::default(),
        Deadline::after(5_000).expect("deadline"),
    )
}

fn one_node_walk(limits: &WalkLimits) -> Result<Walk<ObservedRead>, AdapterError> {
    walk_levels(
        0u32,
        limits,
        Deadline::after(5_000).expect("deadline"),
        |level| {
            Ok(level
                .iter()
                .map(|_| Expansion::read(read_of(PUSH_BUTTON, "b", &["click"]), Vec::new()))
                .collect())
        },
        classify,
    )
}

#[test]
fn a_window_id_decodes_to_the_element_the_walk_starts_from() {
    let id = window_id::encode(":1.7", "/org/a11y/atspi/accessible/1").expect("encodes");
    let window = window(id);
    let mut seen = None;
    let tree = observe_plain(
        ObservationRoot::Window(&window),
        &request(),
        |element, limits, _| {
            seen = Some(element.clone());
            one_node_walk(limits)
        },
    )
    .expect("observes");
    assert!(tree.is_complete());
    let walked = seen.expect("the walk saw the root");
    assert_eq!(
        walked,
        AtspiElement::new(":1.7", "/org/a11y/atspi/accessible/1", 77)
    );
    assert_eq!(walked.frame(), Some(&walked.address()));
}

#[test]
fn a_foreign_window_id_is_invalid_args_and_nothing_is_walked() {
    let window = window("w-12345".to_owned());
    let error = observe_plain(ObservationRoot::Window(&window), &request(), |_, _, _| {
        panic!("the walk must not start")
    })
    .expect_err("rejected");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn a_surface_this_adapter_does_not_walk_is_not_supported() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut menu = request();
    menu.surface = SnapshotSurface::Menu;
    let error = observe_plain(ObservationRoot::Window(&window), &menu, |_, _, _| {
        panic!("the walk must not start")
    })
    .expect_err("rejected");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

pub(super) fn rooted_walk(
    role: u32,
    state_bits: &[u32],
) -> impl Fn(&WalkLimits) -> Result<Walk<ObservedRead>, AdapterError> {
    let state_bits = state_bits.to_vec();
    move |limits| {
        let bits = state_bits.clone();
        walk_levels(
            0u32,
            limits,
            Deadline::after(5_000).expect("deadline"),
            |level| {
                Ok(level
                    .iter()
                    .map(|_| {
                        let mut read = read_of(role, "d", &[]);
                        read.node.traits.states = Field::Present(words(&bits));
                        Expansion::read(read, Vec::new())
                    })
                    .collect())
            },
            classify,
        )
    }
}

#[test]
fn a_sheet_surface_observes_a_modal_dialog() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let walk = rooted_walk(16, &[25, 16]);
    let tree = observe_plain(ObservationRoot::Window(&window), &sheet, |_, limits, _| {
        walk(limits)
    })
    .expect("a modal dialog observes as the sheet");
    assert!(tree.is_complete());
}

#[test]
fn a_sheet_surface_against_a_plain_window_is_element_not_found() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let walk = rooted_walk(23, &[25]);
    let error = observe_plain(ObservationRoot::Window(&window), &sheet, |_, limits, _| {
        walk(limits)
    })
    .expect_err("not a sheet");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn an_element_inside_a_sheet_observes_though_the_element_is_not_itself_a_sheet() {
    let mut element = AtspiElement::new(":1.7", "/org/a11y/atspi/accessible/9", 77);
    element.set_ancestry(crate::tree::element::ancestry::Ancestry::of(
        None, None, false,
    ));
    let handle = element.into_native_handle();
    let mut entry = element_entry();
    entry.source.source_surface = SnapshotSurface::Sheet;
    let root = ObservationRoot::Element {
        handle: &handle,
        entry: &entry,
        root_ref: None,
    };
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let walk = rooted_walk(PUSH_BUTTON, &[]);
    let tree = observe_plain(root, &sheet, |_, limits, _| walk(limits))
        .expect("a button inside a sheet is observed from its own root");
    assert!(tree.is_complete());
}

#[test]
fn an_element_inside_a_menu_observes_from_its_own_root() {
    let mut element = AtspiElement::new(":1.7", "/org/a11y/atspi/accessible/9", 77);
    element.set_ancestry(crate::tree::element::ancestry::Ancestry::of(
        None, None, false,
    ));
    let handle = element.into_native_handle();
    let mut entry = element_entry();
    entry.source.source_surface = SnapshotSurface::Menu;
    let root = ObservationRoot::Element {
        handle: &handle,
        entry: &entry,
        root_ref: None,
    };
    let mut menu = request();
    menu.surface = SnapshotSurface::Menu;
    let walk = rooted_walk(PUSH_BUTTON, &[]);
    let tree = observe_plain(root, &menu, |_, limits, _| walk(limits))
        .expect("a menu item is observed from its own root");
    assert!(tree.is_complete());
}

#[test]
fn a_window_that_left_the_bus_is_window_not_found() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    for code in [ErrorCode::AppNotFound, ErrorCode::ElementNotFound] {
        let error = observe_plain(ObservationRoot::Window(&window), &request(), |_, _, _| {
            Err(AdapterError::new(code.clone(), "gone"))
        })
        .expect_err("gone");
        assert_eq!(error.code, ErrorCode::WindowNotFound);
    }
}

#[test]
fn a_timeout_is_not_rewritten() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let error = observe_plain(ObservationRoot::Window(&window), &request(), |_, _, _| {
        Err(AdapterError::timeout("slow"))
    })
    .expect_err("slow");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn an_incomplete_walk_is_a_success_that_the_all_or_nothing_read_refuses() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let tree = observe_plain(
        ObservationRoot::Window(&window),
        &request(),
        |_, limits, _| {
            let mut walk = one_node_walk(limits)?;
            walk.complete = false;
            walk.root.truncated = true;
            Ok(walk)
        },
    )
    .expect("a cut walk still observes");
    assert!(!tree.is_complete());
    assert_eq!(
        tree.into_accessibility_tree().expect_err("incomplete").code,
        ErrorCode::Timeout
    );
}

#[test]
fn a_request_deeper_than_the_raw_limit_is_rejected_before_any_walk() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut bad = request();
    bad.max_logical_depth = 60;
    let error = observe_plain(ObservationRoot::Window(&window), &bad, |_, _, _| {
        panic!("the walk must not start")
    })
    .expect_err("rejected");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

fn element_entry() -> agent_desktop_core::RefEntry {
    let mut entry = crate::tree::live::test_support::ref_entry("button");
    entry.process.pid = agent_desktop_core::ProcessId::new(77);
    entry.process.process_instance = Some("i".into());
    entry
}

fn seed_seen_by_an_element_root(in_web: bool) -> bool {
    let mut element = AtspiElement::new(":1.7", "/org/a11y/atspi/accessible/9", 77);
    element.set_ancestry(crate::tree::element::ancestry::Ancestry::of(
        None, None, in_web,
    ));
    seed_seen_for(element)
}

fn seed_seen_for(element: AtspiElement) -> bool {
    let handle = element.into_native_handle();
    let entry = element_entry();
    let root = ObservationRoot::Element {
        handle: &handle,
        entry: &entry,
        root_ref: None,
    };
    let mut seed = None;
    observe_plain(root, &request(), |_, limits, _| {
        seed = Some(limits.root_in_web);
        one_node_walk(limits)
    })
    .expect("the element root observes");
    seed.expect("the walk ran")
}

#[test]
fn an_element_root_seeds_the_walk_from_the_web_context_its_handle_carries() {
    assert!(seed_seen_by_an_element_root(true));
    assert!(!seed_seen_by_an_element_root(false));
}

#[test]
fn a_window_root_never_seeds_the_walk_inside_a_web_document() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut seed = None;
    observe_plain(
        ObservationRoot::Window(&window),
        &request(),
        |_, limits, _| {
            seed = Some(limits.root_in_web);
            one_node_walk(limits)
        },
    )
    .expect("observes");
    assert_eq!(seed, Some(false));
}

fn handle_below_a_web_document() -> AtspiElement {
    use crate::tree::live::test_support::read_of;
    use crate::tree::resolve::path_descent::level_of;
    use crate::tree::vocabulary::role_numbers::DOCUMENT_WEB;

    let mut frame = AtspiElement::new(":1.7", "/frame", 77);
    frame.set_ancestry(crate::tree::element::ancestry::of_root(&frame.clone()));
    let mut document = read_of(DOCUMENT_WEB, "page", &[]).node;
    document.element = frame;
    document.children = Field::Present(vec![(":1.7".to_owned(), "/button".to_owned())]);
    let pids = std::collections::HashMap::from([(":1.7".to_owned(), 77)]);
    level_of(&document, &pids, true).children.remove(0)
}

#[test]
fn a_handle_a_descent_landed_on_below_a_web_document_seeds_the_walk_in_a_web_context() {
    let landed = handle_below_a_web_document();
    assert!(seed_seen_for(landed.clone()));

    let mut flattened = landed.clone();
    flattened.set_ancestry(crate::tree::element::ancestry::Ancestry::of(
        landed.frame().cloned(),
        None,
        false,
    ));
    assert!(!seed_seen_for(flattened));
}

#[test]
fn a_window_of_a_stopped_process_is_unresponsive_and_a_running_one_passes() {
    let id = window_id::encode(":1.7", "/stopped/x4a00003").expect("an id");
    let mut listed = window(id);
    listed.app = "Calculator".to_owned();
    let error = refuse_stopped(&listed, |pid| pid == 77).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.message.contains("Calculator"));
    assert!(refuse_stopped(&listed, |_| false).is_ok());
}

#[test]
fn optional_display_completion_runs_after_the_accessibility_walk() {
    let walked = std::cell::Cell::new(false);
    let window = window(window_id::encode(":1.7", "/a").unwrap());
    let tree = super::observe_decorated(
        ObservationRoot::Window(&window),
        &request(),
        SettleHost {
            walker: &mut |_, limits, _, _| {
                walked.set(true);
                one_node_walk(limits)
            },
            place: &mut |_| Ok(()),
            is_web_process: &|_| Ok(false),
            stopped: &|_| false,
            pause: &mut |_| {},
        },
        &mut super::Plain,
        || {
            assert!(walked.get(), "optional display reads cannot block the walk");
            None
        },
    )
    .unwrap();
    assert!(tree.is_complete());
}
