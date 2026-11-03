use crate::input::held_input::HeldInput;
use crate::input::x11::fake_sink::{FakeSink, Recorded, deadline};
use crate::input::x11::verify;

fn keys_down(codes: &[u8]) -> [u8; 32] {
    let mut bits = [0; 32];
    for code in codes {
        bits[usize::from(*code / 8)] |= 1 << (code % 8);
    }
    bits
}

#[test]
fn a_transient_release_read_does_not_fail_or_reinject_the_shortcut() {
    for keys in [vec![64, 23], vec![64, 76]] {
        let mut fake = FakeSink::new();
        fake.scripted_key_reads(vec![keys_down(&keys), keys_down(&[])]);
        let touched = HeldInput {
            keys,
            buttons: Vec::new(),
        };

        verify::check(&mut fake, &touched, deadline(1_000)).expect("keys settled released");

        assert!(fake.recorded().is_empty());
    }
}

#[test]
fn a_persistent_touched_key_still_fails_and_runs_release_cleanup() {
    let mut fake = FakeSink::new();
    let touched = HeldInput {
        keys: vec![64],
        buttons: Vec::new(),
    };
    fake.world().sticky_keys.push(64);

    let error = verify::check(&mut fake, &touched, deadline(1_000)).expect_err("key stays held");

    assert_eq!(
        error.details.unwrap()["leftover_keys"],
        serde_json::json!([64])
    );
    assert_eq!(
        fake.recorded(),
        [Recorded::Key(64, false), Recorded::RoundTrip]
    );
}

#[test]
fn button_release_settles_without_reinjection_but_a_held_button_still_refuses() {
    use crate::input::x11::pointer_read::PointerRead;
    let mut fake = FakeSink::new();
    fake.scripted_pointer_reads(vec![
        PointerRead {
            x: 0,
            y: 0,
            mask: 0x0100,
        },
        PointerRead {
            x: 0,
            y: 0,
            mask: 0,
        },
    ]);
    let touched = HeldInput {
        keys: Vec::new(),
        buttons: vec![1],
    };
    verify::check(&mut fake, &touched, deadline(1_000)).expect("button release settles");
    assert!(
        fake.recorded().is_empty(),
        "a delayed read must not inject another release"
    );
    fake.world().sticky_buttons.push(1);
    let error =
        verify::check(&mut fake, &touched, deadline(1_000)).expect_err("button remains held");
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        error.details.expect("held input evidence")["leftover_buttons"],
        serde_json::json!([1])
    );
    assert_eq!(
        fake.recorded(),
        [Recorded::Button(1, false), Recorded::RoundTrip]
    );
}
