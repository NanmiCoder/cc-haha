use std::sync::Arc;

use agent_desktop_core::DeliverySemantics;

use crate::input::keyboard::keymap_edit::KeymapEdit;
use crate::input::x11::fake_sink::{FakeSink, deadline, run, start_keymap};

#[test]
fn text_planning_recovers_own_pending_remaps_before_reading_the_keymap() {
    use crate::input::{held_input::HeldInput, x11::held_journal::HeldJournal};
    for recovery_fails in [false, true] {
        let dir = std::env::temp_dir().join(format!(
            "ad-planning-remap-{}-{recovery_fails}",
            std::process::id()
        ));
        let fake = FakeSink::new();
        fake.world().keymap.keysyms[8..10].copy_from_slice(&[0x01004f60; 2]);
        if recovery_fails {
            fake.world().fail_on_event = Some(1);
        }
        let journal = HeldJournal::at(dir.clone(), ":7", std::process::id());
        journal
            .record(
                &HeldInput::default(),
                &[KeymapEdit {
                    keycode: 12,
                    keysyms: vec![0, 0],
                }],
            )
            .unwrap();
        let sink = fake.clone();
        let map = super::read_keymap(
            move || Ok(sink),
            Some(journal),
            Arc::default(),
            deadline(5_000),
            None,
        );
        if recovery_fails {
            let error = map.expect_err("an unrestored mapping cannot authorize planning");
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
            assert!(dir.join(format!("{}.json", std::process::id())).exists());
        } else {
            let map = map.expect("recovered map");
            assert_eq!(map, start_keymap());
            let plans = crate::input::keyboard::text_plan::plan_text(&map, "你").unwrap();
            run(&fake, plans, &mut || Ok(()), deadline(5_000), None).unwrap();
            assert_eq!(fake.world().keymap, start_keymap());
            assert!(!dir.join(format!("{}.json", std::process::id())).exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
