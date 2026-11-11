use std::time::{Duration, Instant};

use agent_desktop_core::{
    AdapterError, DeliveryDisposition, ErrorCode, NativeHandle, RetryDisposition,
};
use zbus::zvariant::Value;

use crate::actions::action_call::do_action;
use crate::actions::chain::chain_def::ChainDef;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::chain::chain_rung::Rung;
use crate::actions::chain::execute_chain;
use crate::actions::write::mutation::{WriteKind, WriteReply};
use crate::actions::write::write_call::{Call, invoke};

#[path = "live_write_fixture.rs"]
mod fixture;
#[path = "live_write_rig.rs"]
mod rig;

use fixture::{Suspended, launch, signal, wait_until};
use rig::{ROLE_PROGRESS_BAR, ROLE_PUSH_BUTTON, describe, probe, target};

const TOOLKITS: [&str; 3] = ["gtk3", "gtk4", "qt"];
const TOGGLE_VERBS: [&str; 4] = ["toggle", "click", "press", "activate"];
const VALUE_INTERFACE: &str = "org.a11y.atspi.Value";
const SETTLE: Duration = Duration::from_secs(5);

fn assert_stays<T: std::fmt::Debug + PartialEq>(
    label: &str,
    before: T,
    mut read: impl FnMut() -> Option<T>,
) {
    let started = Instant::now();
    loop {
        assert_eq!(read().expect("state remains readable"), before, "[{label}]");
        if started.elapsed() >= SETTLE {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn set_current_value(
    target: &crate::actions::context::Target<'_>,
    value: f64,
) -> Result<WriteReply, AdapterError> {
    invoke(
        target,
        Call {
            interface: "org.freedesktop.DBus.Properties",
            method: "Set",
            body: &(VALUE_INTERFACE, "CurrentValue", Value::F64(value)),
            kind: WriteKind::SetProperty,
        },
    )
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_the_chain_skips_an_absent_verb_and_reports_what_a_re_read_saw() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let flag = probe.toggle(app.pid);
        let handle = NativeHandle::new(flag.clone());
        let names = probe.action_names(&flag);
        let before = probe.checked(&flag).expect("the state reads");
        let t = target(&probe, &handle, &flag, 5_000);
        let mut rungs = [
            Rung {
                label: "Action.DoAction",
                run: Box::new(|| {
                    Ok(match do_action(&t, &names, &["no-such-verb"])? {
                        WriteReply::Done => DeliveryOutcome::Delivered(Observed::Unread),
                        WriteReply::Absent => DeliveryOutcome::NotDelivered,
                    })
                }),
            },
            Rung {
                label: "Action.DoAction",
                run: Box::new(|| match do_action(&t, &names, &TOGGLE_VERBS)? {
                    WriteReply::Absent => Ok(DeliveryOutcome::NotDelivered),
                    WriteReply::Done => {
                        let flipped = wait_until(SETTLE, || probe.checked(&flag) == Some(!before));
                        Ok(DeliveryOutcome::Delivered(if flipped {
                            Observed::Matched
                        } else {
                            Observed::Unchanged
                        }))
                    }
                }),
            },
        ];
        let def = ChainDef {
            action: "toggle",
            suggestion: "refresh",
        };
        let result = execute_chain(&def, &mut rungs, t.deadline).expect("the chain delivers");
        println!("write_live {label}: chain {:?}", result.disposition());
        assert_eq!(result.steps.len(), 2, "[{label}]");
        assert_eq!(result.steps[0].verified(), None, "[{label}]");
        assert_eq!(result.steps[1].verified(), Some(true), "[{label}]");
        assert_eq!(
            result.disposition().delivery(),
            DeliveryDisposition::DeliveredVerified,
            "[{label}]"
        );
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_a_read_only_value_never_reads_back_as_written() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let bar = probe.with_role(app.pid, ROLE_PROGRESS_BAR, None);
        let handle = NativeHandle::new(bar.clone());
        let before = probe.value(&bar).expect("the progress value reads");
        let reply = set_current_value(&target(&probe, &handle, &bar, 5_000), 90.0);
        let shown = reply.as_ref().map_err(describe);
        println!("write_live {label}: progress {before:?} reply {shown:?}");
        assert!(matches!(reply, Ok(WriteReply::Done)), "[{label}] {shown:?}");
        assert_stays(label, before, || probe.value(&bar));
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_an_index_the_node_does_not_have_changes_nothing() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let flag = probe.toggle(app.pid);
        let handle = NativeHandle::new(flag.clone());
        let before = probe.checked(&flag).expect("the toggle state reads");
        let reply = invoke(
            &target(&probe, &handle, &flag, 5_000),
            Call {
                interface: "org.a11y.atspi.Action",
                method: "DoAction",
                body: &(99i32,),
                kind: WriteKind::DoAction,
            },
        );
        let shown = reply.as_ref().map_err(describe);
        println!("write_live {label}: index 99 reply {shown:?}");
        if label == "gtk3" {
            assert!(matches!(reply, Ok(WriteReply::Done)), "[{label}] {shown:?}");
        } else {
            assert!(
                matches!(reply, Ok(WriteReply::Absent)),
                "[{label}] {shown:?}"
            );
        }
        assert_stays(label, before, || probe.checked(&flag));
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_a_destroyed_widget_is_stale_where_the_toolkit_reports_it() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let victim = probe.with_role(app.pid, ROLE_PUSH_BUTTON, Some("Victim"));
        let handle = NativeHandle::new(victim.clone());
        let names = probe.action_names(&victim);
        let parent = probe.find(app.pid, &|probe, element| probe.lists(element, &victim));
        let framed = probe.framed(app.pid, &victim);
        app.send("remove");
        assert!(
            wait_until(SETTLE, || !probe.lists(&parent, &victim)),
            "[{label}] the victim leaves its parent"
        );
        let started = Instant::now();
        let reply = do_action(
            &target(&probe, &handle, &victim, 4_000),
            &names,
            &["click", "press"],
        );
        let shown = reply.as_ref().map_err(describe);
        println!(
            "write_live {label}: destroyed reply {shown:?} in {} ms",
            started.elapsed().as_millis()
        );
        if label != "gtk3" {
            let error = reply.expect_err("a destroyed widget takes no write");
            assert_eq!(error.code, ErrorCode::StaleRef, "[{label}] {error:?}");
            assert_eq!(
                error.disposition.delivery(),
                DeliveryDisposition::NotDelivered,
                "[{label}]"
            );
        }
        let framed_handle = NativeHandle::new(framed.clone());
        let clicked = crate::actions::click::click(&target(&probe, &framed_handle, &framed, 4_000));
        println!(
            "write_live {label}: destroyed click {:?}",
            clicked.as_ref().map_err(describe)
        );
        let error = clicked.expect_err("a destroyed widget is never a delivered click");
        assert_eq!(error.code, ErrorCode::StaleRef, "[{label}] {error:?}");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered,
            "[{label}]"
        );
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_a_stopped_app_is_a_timeout_that_may_have_landed() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let flag = probe.toggle(app.pid);
        let handle = NativeHandle::new(flag.clone());
        let names = probe.action_names(&flag);
        let before = probe.checked(&flag).expect("the state reads");
        let stopped = Suspended::new(app.pid);
        let started = Instant::now();
        let error = do_action(
            &target(&probe, &handle, &flag, 2_000),
            &names,
            &TOGGLE_VERBS,
        )
        .expect_err("a stopped app does not answer");
        let elapsed = started.elapsed();
        println!(
            "write_live {label}: stopped {} in {elapsed:?}",
            describe(&error)
        );
        drop(stopped);
        assert_eq!(error.code, ErrorCode::Timeout, "[{label}]");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::DeliveryUncertain,
            "[{label}]"
        );
        assert_eq!(
            error.disposition.retry(),
            RetryDisposition::Unsafe,
            "[{label}]"
        );
        assert!(
            elapsed < Duration::from_millis(3_500),
            "[{label}] {elapsed:?}"
        );
        let landed = wait_until(SETTLE, || probe.checked(&flag) == Some(!before));
        println!("write_live {label}: after SIGCONT the write landed={landed}");
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn write_live_a_killed_app_is_a_stale_ref_that_was_not_delivered() {
    for label in TOOLKITS {
        let app = launch(label);
        let probe = probe();
        let flag = probe.toggle(app.pid);
        let handle = NativeHandle::new(flag.clone());
        let names = probe.action_names(&flag);
        signal(app.pid, "KILL");
        assert!(
            wait_until(SETTLE, || probe.role(&flag).is_none()),
            "[{label}] the killed app leaves the bus"
        );
        let started = Instant::now();
        let error = do_action(
            &target(&probe, &handle, &flag, 4_000),
            &names,
            &TOGGLE_VERBS,
        )
        .expect_err("a killed app does not answer");
        println!(
            "write_live {label}: killed {} in {} ms",
            describe(&error),
            started.elapsed().as_millis()
        );
        assert_eq!(error.code, ErrorCode::StaleRef, "[{label}]");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered,
            "[{label}]"
        );
        assert_eq!(
            error.disposition.retry(),
            RetryDisposition::Safe,
            "[{label}]"
        );
    }
}
