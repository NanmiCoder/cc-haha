use std::time::Duration;

use agent_desktop_core::{Action, Direction, KeyCombo, Modifier, NativeHandle};

use super::live_launch::Launched;
use super::live_offscreen_live_tests::scripts::QT_LIST;
use super::physical_live_rig::{Kit, Scene};
use crate::actions::scroll_into_view;

fn app_scene(program: &str, args: &[&str], min_nodes: usize) -> Scene {
    let mut launched = Launched::new();
    let pid = launched.spawn(program, args);
    Scene::attach(launched, pid, String::new(), min_nodes)
}

fn type_and_read(
    scene: &Scene,
    field: &NativeHandle,
    text: &str,
    replace: bool,
    complete: impl Fn(&str) -> bool,
) -> String {
    scene
        .act(field, Action::Click)
        .expect("the focusing click is delivered");
    std::thread::sleep(Duration::from_millis(500));
    if replace {
        let select_all = KeyCombo {
            key: "a".to_owned(),
            modifiers: vec![Modifier::Ctrl],
        };
        scene
            .act(field, Action::PressKey(select_all))
            .expect("select all");
    }
    scene
        .act(field, Action::TypeText(text.to_owned()))
        .expect("the text is typed");
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        let value = scene.value_of(field).unwrap_or_default();
        if complete(&value) || std::time::Instant::now() >= deadline {
            return value;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn live_text_editor_receives_typed_text_with_remapped_characters() {
    let scene = app_scene("gnome-text-editor", &[], 5);
    let field = scene.find(&["textfield"], None);
    let text = "h\u{e9}llo \u{65e5}\u{672c}";
    assert_eq!(
        type_and_read(&scene, &field, text, true, |value| value == text),
        text
    );
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn live_calculator_evaluates_typed_keys() {
    let scene = app_scene("gnome-calculator", &[], 10);
    let display = scene.find(&["textfield"], None);
    let shown = type_and_read(&scene, &display, "6*7=", false, |value| {
        value.contains("42")
    });
    assert!(shown.contains("42"), "the display reads {shown:?}");
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn live_qt_headless_reveal_has_no_container_while_the_headed_wheel_moves_the_content() {
    let scene = Scene::open(Kit::Qt, QT_LIST, 20);
    let far = scene.find(&["option"], Some("Item 040"));
    let list = scene.find(&["listbox"], None);
    let baseline = scene.wait_log(|text| serde_json::from_str::<serde_json::Value>(text).is_ok());
    let before: serde_json::Value = serde_json::from_str(&baseline).expect("Qt scroll baseline");
    let offset = before["offset"].as_i64().expect("Qt content offset");
    assert_eq!(
        before["visible"], false,
        "the far item starts outside the viewport"
    );
    let error = {
        let lease = scene.lease();
        scroll_into_view(&scene.bus, &far, &lease)
            .expect_err("a Qt list has no scroll container to drive headless")
    };
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["cause"], "no_scroll_container", "{details}");
    assert_eq!(
        scene.log_text(),
        baseline,
        "headless refusal did not scroll"
    );
    scene
        .act(&list, Action::Scroll(Direction::Down, 13))
        .expect("the headed wheel is delivered");
    let observed = scene.wait_log(|text| {
        serde_json::from_str::<serde_json::Value>(text).is_ok_and(|state| {
            state["offset"].as_i64().is_some_and(|after| after > offset) && state["visible"] == true
        })
    });
    let after: serde_json::Value =
        serde_json::from_str(&observed).expect("Qt scroll postcondition");
    assert!(
        after["offset"].as_i64().expect("Qt content offset") > offset,
        "{before} -> {after}"
    );
    assert_eq!(
        after["visible"], true,
        "Qt confirms the far item is visible"
    );
}
