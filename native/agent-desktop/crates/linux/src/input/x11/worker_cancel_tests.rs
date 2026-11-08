use super::{check_alive, run_step};
use crate::input::keyboard::keymap_edit::KeymapEdit;
use crate::input::release_guard::ReleaseGuard;
use crate::input::step::Step;
use crate::input::x11::fake_sink::{FakeSink, deadline, events};
use crate::input::x11::progress::Progress;

#[test]
fn cancellation_after_the_alive_check_prevents_every_kind_of_first_send() {
    for step in [
        Step::Key {
            code: 12,
            down: true,
        },
        Step::Button {
            code: 1,
            down: true,
        },
        Step::MoveTo { x: 10, y: 10 },
        Step::Keymap(KeymapEdit {
            keycode: 12,
            keysyms: vec![0x1234; 2],
        }),
    ] {
        let mut fake = FakeSink::new();
        let progress = Progress::default();
        let deadline = deadline(30_000);
        let mut guard = ReleaseGuard::new(&mut fake);
        check_alive(deadline, &progress, 0).unwrap();
        progress.cancel();

        let error = run_step(&mut guard, &step, deadline, &progress)
            .expect_err("cancellation must win the dispatch decision");
        drop(guard);

        assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
        assert!(!progress.has_started());
        assert!(events(&fake).is_empty(), "sent {step:?} after cancellation");
    }
}
