use agent_desktop_core::{DeliveryDisposition, ErrorCode};

use crate::input::plan::Plan;
use crate::input::step::Step;
use crate::input::x11::fake_sink::{FakeSink, Recorded, deadline, events, run};

#[test]
fn text_chunks_read_fresh_state_without_keyboard_mapping_or_pointer_geometry() {
    let fake = FakeSink::new();
    let plans = crate::input::keyboard::text_plan::plan_text(&fake.world().keymap, &"a".repeat(65))
        .unwrap();
    let mut chunks = 0;
    let error = run(
        &fake,
        plans,
        &mut || {
            chunks += 1;
            if chunks == 3 {
                fake.world().keymap.modifiers = 2;
            }
            Ok(())
        },
        deadline(5_000),
        None,
    )
    .expect_err("a lock change between chunks must stop text delivery");
    assert_eq!(events(&fake).len(), 128);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        fake.world().queries,
        ["text_state", "text_state", "text_state"]
    );
}

#[test]
fn keyboard_state_changed_after_planning_refuses_before_the_first_key() {
    let fake = FakeSink::new();
    let plans = crate::input::keyboard::text_plan::plan_text(&fake.world().keymap, "a").unwrap();
    let error = run(
        &fake,
        plans,
        &mut || {
            fake.world().keymap.modifiers = 2;
            Ok(())
        },
        deadline(5_000),
        None,
    )
    .expect_err("CapsLock changed while waiting for the target gate");
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(events(&fake).is_empty());
}

#[test]
fn failed_post_dispatch_queries_keep_delivery_evidence_and_refuse_replay() {
    for steps in [
        vec![
            Step::Key {
                code: 38,
                down: true,
            },
            Step::Key {
                code: 38,
                down: false,
            },
        ],
        vec![
            Step::Button {
                code: 1,
                down: true,
            },
            Step::Button {
                code: 1,
                down: false,
            },
        ],
    ] {
        let fake = FakeSink::new();
        fake.world().fail_verification = true;
        let error = run(
            &fake,
            vec![Plan {
                steps,
                release_origin: None,
            }],
            &mut || Ok(()),
            deadline(5_000),
            None,
        )
        .unwrap_err();
        assert_eq!(events(&fake).len(), 2);
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
        let details = error
            .details
            .expect("dispatch evidence survives a failed query");
        assert_eq!(details["delivered_events"], 2);
        assert_eq!(details["physical_delivery_started"], true);
        assert_eq!(error.suggestion.as_deref(), Some(super::ABORT_SUGGESTION));
    }
}

#[test]
fn a_failed_first_dispatch_is_uncertain_and_unsafe_to_retry() {
    let fake = FakeSink::new().failing_on(1);
    let plan = Plan {
        steps: vec![Step::Key {
            code: 38,
            down: true,
        }],
        release_origin: None,
    };
    let error = run(&fake, vec![plan], &mut || Ok(()), deadline(5_000), None).unwrap_err();
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::uncertain()
    );
    assert_eq!(error.details.unwrap()["physical_delivery_started"], true);
    assert_eq!(error.suggestion.as_deref(), Some(super::ABORT_SUGGESTION));

    let dir =
        std::env::temp_dir().join(format!("ad-worker-blocked-journal-{}", std::process::id()));
    let _ = std::fs::remove_file(&dir);
    std::fs::write(&dir, "not a directory").unwrap();
    let refused = FakeSink::new();
    let sink = refused.clone();
    let error = super::super::session::run_journaled(
        move || Ok(sink),
        vec![Plan {
            steps: vec![Step::Key {
                code: 38,
                down: true,
            }],
            release_origin: None,
        }],
        &mut || Ok(()),
        super::super::session::CallEnv {
            deadline: deadline(5_000),
            journal: Some(super::super::held_journal::HeldJournal::at(
                dir.clone(),
                ":7",
                std::process::id(),
            )),
            slot: std::sync::Arc::default(),
            release_on_signal: false,
            lease: None,
        },
    )
    .unwrap_err();
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(events(&refused).is_empty());
    std::fs::remove_file(dir).unwrap();
}

#[test]
fn failed_stale_recovery_blocks_the_next_plan_and_keeps_the_record() {
    use crate::input::held_input::HeldInput;
    use crate::input::x11::{held_journal::HeldJournal, session, worker_slot::WorkerSlot};
    for pid in [4_000_000_000, std::process::id()] {
        let dir = std::env::temp_dir().join(format!("ad-stale-block-{}-{pid}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        HeldJournal::at(dir.clone(), ":7", pid)
            .record(
                &HeldInput {
                    keys: vec![38],
                    buttons: vec![],
                },
                &[],
            )
            .unwrap();
        let journal = HeldJournal::at(dir.clone(), ":7", std::process::id());
        let fake = FakeSink::new().failing_on(1);
        let sink = fake.clone();
        let plan = Plan {
            steps: vec![Step::Key {
                code: 39,
                down: true,
            }],
            release_origin: None,
        };
        let mut gated = false;
        session::run_journaled(
            move || Ok(sink),
            vec![plan],
            &mut || {
                gated = true;
                Ok(())
            },
            session::CallEnv {
                deadline: deadline(5_000),
                journal: Some(journal.clone()),
                slot: std::sync::Arc::new(WorkerSlot::default()),
                release_on_signal: false,
                lease: None,
            },
        )
        .expect_err("stale release was not acknowledged");
        assert!(!gated);
        assert!(!events(&fake).contains(&Recorded::Key(39, true)));
        let pending = dir.join(format!("{pid}.json"));
        assert!(pending.exists());
        journal
            .release_stale(&mut fake.clone())
            .expect("recovery can be retried");
        assert!(!pending.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn a_point_outside_the_root_is_refused_before_any_event() {
    let outside = [
        (i32::MIN, 0),
        (-1, 0),
        (0, -1),
        (1280, 0),
        (0, 800),
        (5_000, 5_000),
    ];
    for (x, y) in outside {
        let fake = FakeSink::new();
        let moving = Plan {
            steps: vec![
                Step::Key {
                    code: 38,
                    down: true,
                },
                Step::MoveTo { x, y },
            ],
            release_origin: None,
        };

        let error =
            run(&fake, vec![moving], &mut || Ok(()), deadline(5_000), None).expect_err("outside");

        assert_eq!(error.code, ErrorCode::InvalidArgs, "({x}, {y})");
        assert!(events(&fake).is_empty(), "({x}, {y}) sent an event");
    }
    for (x, y) in [(0, 0), (1279, 799), (0, 799), (1279, 0)] {
        let fake = FakeSink::new();
        let moving = Plan {
            steps: vec![Step::MoveTo { x, y }],
            release_origin: None,
        };

        run(&fake, vec![moving], &mut || Ok(()), deadline(5_000), None).expect("inside");

        assert_eq!(events(&fake), [Recorded::Move(x as i16, y as i16)]);
    }
}

#[test]
fn owned_sticky_input_is_reported_without_claiming_bystander_input() {
    let fake = FakeSink::new();
    fake.world().sticky_buttons.push(1);
    fake.world().sticky_buttons.push(3);
    fake.world().sticky_keys.push(38);
    fake.world().sticky_keys.push(39);
    let click = Plan {
        steps: vec![
            Step::Key {
                code: 38,
                down: true,
            },
            Step::Key {
                code: 38,
                down: false,
            },
            Step::Button {
                code: 1,
                down: true,
            },
            Step::Button {
                code: 1,
                down: false,
            },
        ],
        release_origin: None,
    };

    let error = run(&fake, vec![click], &mut || Ok(()), deadline(5_000), None).expect_err("held");

    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    let details = error.details.expect("details");
    assert_eq!(details["leftover_buttons"], serde_json::json!([1]));
    assert_eq!(details["leftover_keys"], serde_json::json!([38]));
}

#[test]
fn the_worker_runs_the_planned_hold_between_the_keys_and_the_restore() {
    use crate::input::keyboard::keymap_edit::KeymapEdit;
    use std::time::Instant;
    let fake = FakeSink::new();
    let typed = Plan {
        steps: vec![
            Step::Keymap(KeymapEdit {
                keycode: 12,
                keysyms: vec![0x1234, 0x1234],
            }),
            Step::Key {
                code: 12,
                down: true,
            },
            Step::Key {
                code: 12,
                down: false,
            },
            Step::Pause(std::time::Duration::from_millis(50)),
            Step::Keymap(KeymapEdit {
                keycode: 12,
                keysyms: vec![0, 0],
            }),
        ],
        release_origin: None,
    };
    let started = Instant::now();

    run(&fake, vec![typed], &mut || Ok(()), deadline(5_000), None).expect("typed");

    assert!(
        started.elapsed() >= std::time::Duration::from_millis(50),
        "the remap was restored before the keys were consumed"
    );
}
