use super::owning_window_minimized;
use crate::tree::automation::root_from_hwnd;
use crate::tree::fixture::{LocalFixture, bootstrap};
use agent_desktop_core::Deadline;
use std::time::Duration;

fn deadline() -> Deadline {
    Deadline::standard().expect("a standard deadline")
}

fn root_of(fixture: &LocalFixture) -> crate::tree::element::UIAElement {
    root_from_hwnd(fixture.handle(), deadline()).expect("the fixture root resolves")
}

#[test]
fn a_restored_window_reports_not_minimized() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");

    assert_eq!(
        owning_window_minimized(&root_of(&fixture), deadline()),
        Some(false)
    );
}

#[test]
fn a_minimized_window_reports_minimized() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    fixture.minimize();
    std::thread::sleep(Duration::from_millis(250));

    assert_eq!(
        owning_window_minimized(&root_of(&fixture), deadline()),
        Some(true)
    );
}
