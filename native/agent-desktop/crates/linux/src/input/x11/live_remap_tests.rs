use std::process::Command;
use std::time::{Duration, Instant};

use super::live_tests::{deadline, private_display, spawn_helper};
use super::session::{live_keymap, run};
use crate::input::keyboard::keymap_edit::KeymapEdit;
use crate::input::plan::Plan;
use crate::input::step::Step;

const MARKER: u32 = 0x1234;
const WRITTEN_LEVELS: usize = 4;

pub(crate) fn observed_keymap(display: &str) -> crate::input::keyboard::keymap::Keymap {
    use super::{sink::X11Sink, xtest_sink::XtestSink};
    XtestSink::connect(display, deadline(8_000), Duration::from_secs(10))
        .unwrap()
        .keymap()
        .unwrap()
}

fn wait_for_keysyms(display: &str, code: u8, wanted: &[u32]) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        let map = observed_keymap(display);
        if map.keysyms_of(code).as_deref() == Some(wanted) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[test]
#[ignore = "needs scripts/private-session.sh --wm"]
fn live_text_after_own_pending_remap_reaches_the_editor_and_bad_recovery_refuses() {
    use super::{held_journal::HeldJournal, sink::X11Sink, xtest_sink::XtestSink};
    use crate::input::{held_input::HeldInput, keyboard::text_plan::plan_text};
    use crate::system::x11::stacking::stacking_source::StackingSource;
    let display = private_display();
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap();
    let log = std::path::Path::new(&runtime).join("typed.txt");
    let focus = std::path::Path::new(&runtime).join("entry-focused");
    std::fs::write(&log, "").unwrap();
    std::fs::write(&focus, "False").unwrap();
    let source = super::live_tests::GTK3.replace(
        "w.show_all()",
        "e.connect('notify::has-focus', lambda x, p: open(os.environ['AD_FOCUS_LOG'], 'w').write(str(x.has_focus())))\nw.show_all()\ne.grab_focus()",
    );
    let mut app = Command::new("python3")
        .args(["-c", &source])
        .env("AD_LIVE_LOG", &log)
        .env("AD_FOCUS_LOG", &focus)
        .spawn()
        .unwrap();
    let started = Instant::now();
    let client = loop {
        if let crate::system::x11::X11State::Ready { clients, .. } =
            crate::system::x11::DisplayReader.clients_within(deadline(3_000))
        {
            if let Some(client) = clients.into_iter().find(|client| {
                client.pid == Some(app.id()) && !client.hidden && client.bounds.is_some()
            }) {
                break client;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "fixture not mapped"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let facts = crate::system::process::process_facts::read(app.id()).unwrap();
    let owner = agent_desktop_core::ProcessIdentity::new(app.id(), facts.instance);
    crate::system::x11::control::control_send::activate_window(
        client.id,
        &owner,
        deadline(8_000),
        true,
    )
    .unwrap();
    let started = Instant::now();
    loop {
        let active = Command::new("xprop")
            .args(["-root", "_NET_ACTIVE_WINDOW"])
            .output()
            .unwrap();
        assert!(active.status.success());
        let text = String::from_utf8(active.stdout).unwrap();
        let active = text
            .split_whitespace()
            .last()
            .and_then(|id| id.strip_prefix("0x"))
            .and_then(|id| u32::from_str_radix(id, 16).ok());
        if active == Some(client.id) && std::fs::read_to_string(&focus).unwrap() == "True" {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "fixture not focused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let lease = crate::system::interaction::interaction_lease::acquire(deadline(30_000)).unwrap();
    let map = live_keymap(&display, &lease).unwrap();
    let code = map.spare_keycodes(1)[0];
    let original = map.keysyms_of(code).unwrap();
    let journal = HeldJournal::in_runtime_dir(&display).unwrap();
    journal
        .record(
            &HeldInput::default(),
            &[KeymapEdit {
                keycode: code,
                keysyms: original.clone(),
            }],
        )
        .unwrap();
    let mut sink = XtestSink::connect(&display, deadline(8_000), Duration::from_secs(30)).unwrap();
    sink.edit_keymap(&KeymapEdit {
        keycode: code,
        keysyms: vec![0x01004f60; original.len()],
    })
    .unwrap();
    sink.round_trip().unwrap();
    let recovered = live_keymap(&display, &lease).unwrap();
    let plans = plan_text(&recovered, "你").unwrap();
    run(&display, plans, &mut || Ok(()), &lease).unwrap();
    let started = Instant::now();
    while std::fs::read_to_string(&log).unwrap() != "你" {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "editor text: {:?}",
            std::fs::read_to_string(&log)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let independent = Command::new("xmodmap").arg("-pke").output().unwrap();
    assert!(independent.status.success());
    let row = String::from_utf8(independent.stdout)
        .unwrap()
        .lines()
        .find(|row| row.split_whitespace().nth(1) == Some(&code.to_string()))
        .unwrap()
        .to_owned();
    assert!(row.split_once('=').unwrap().1.trim().is_empty(), "{row}");
    let record = std::path::Path::new(&runtime).join("agent-desktop-input/4000000000.json");
    std::fs::write(&record, "unreadable").unwrap();
    let refused = live_keymap(&display, &lease).unwrap_err();
    assert_eq!(
        refused.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "你");
    app.kill().unwrap();
    app.wait().unwrap();
    std::fs::remove_file(log).unwrap();
    std::fs::remove_file(focus).unwrap();
}

#[test]
#[ignore = "needs scripts/private-session.sh --wm"]
fn live_a_remap_left_by_a_killed_client_is_restored_by_the_next_call() {
    let display = private_display();
    let map = observed_keymap(&display);
    let code = *map.spare_keycodes(1).first().expect("a spare keycode");
    let original = map.keysyms_of(code).expect("the row");
    let written = vec![MARKER; WRITTEN_LEVELS];
    let mut remapped = written.clone();
    remapped.resize(original.len(), 0);
    if std::env::var("AD_REMAP_HELPER").is_ok() {
        let hold = Plan {
            steps: vec![
                Step::Keymap(KeymapEdit {
                    keycode: code,
                    keysyms: written,
                }),
                Step::Pause(Duration::from_secs(60)),
            ],
            release_origin: None,
        };
        let lease = crate::system::interaction::interaction_lease::acquire(deadline(70_000))
            .expect("lease");
        let _ = run(&display, vec![hold], &mut || Ok(()), &lease);
        return;
    }
    let mut child = spawn_helper(
        "input::x11::live_remap_tests::live_a_remap_left_by_a_killed_client_is_restored_by_the_next_call",
        "AD_REMAP_HELPER",
    );
    assert!(
        wait_for_keysyms(&display, code, &remapped),
        "the remap never appeared"
    );
    Command::new("kill")
        .args(["-KILL", &child.id().to_string()])
        .status()
        .expect("kill");
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(500));
    let left = observed_keymap(&display);
    assert_eq!(
        left.keysyms_of(code).as_deref(),
        Some(remapped.as_slice()),
        "the server restored the keymap by itself, so the journal is not needed"
    );
    let nudge = Plan {
        steps: vec![Step::MoveTo { x: 3, y: 3 }],
        release_origin: None,
    };
    let lease =
        crate::system::interaction::interaction_lease::acquire(deadline(8_000)).expect("lease");
    run(&display, vec![nudge], &mut || Ok(()), &lease).expect("next call");
    assert!(
        wait_for_keysyms(&display, code, &original),
        "the next call did not restore the keymap a killed client left remapped"
    );
}
