use std::time::{Duration, Instant};

use super::signal_live_apps::{
    Rig, capture, count_of, diff, found_event, identity_of, outcome, poll, process_gone, signal,
    tokens, wait_event, x11_windows,
};

const OPEN_MS: u64 = 15_000;

fn editor(rig: &mut Rig) -> (u32, String) {
    let pid = rig.spawn("gnome-text-editor", &["--new-window"]);
    poll("the editor window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (name, _) = identity_of(rig, pid);
    (pid, name)
}

fn calculator(rig: &mut Rig) -> (u32, String) {
    let pid = rig.spawn("gnome-calculator", &[]);
    poll("the calculator window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (name, _) = identity_of(rig, pid);
    (pid, name)
}

fn pid_is(event: &serde_json::Value, pid: u32) -> bool {
    event["pid"].as_u64() == Some(u64::from(pid))
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_text_editor_new_window_handoff_is_window_opened_without_app_launched() {
    let mut rig = Rig::new();
    let (pid, _) = editor(&mut rig);
    let seed = capture(&rig, None, None, 10_000).expect("the seed capture");
    let second = rig.spawn("gnome-text-editor", &["--new-window"]);
    poll("the second editor frame", || {
        (x11_windows(pid).len() == 2).then_some(())
    });
    poll("the handoff launcher to exit", || {
        process_gone(second).then_some(())
    });
    let result = wait_event(&rig, "window-opened", None, OPEN_MS, Some(Ok(seed.clone())));
    assert!(
        pid_is(found_event(&result), pid),
        "the new frame belongs to the old pid {pid}: {}",
        outcome(&result)
    );
    let after = capture(&rig, None, None, 10_000).expect("the capture after");
    let events = diff(&seed, &after);
    assert_eq!(
        (
            count_of(&events, "window-opened"),
            count_of(&events, "app-launched")
        ),
        (1, 0),
        "{:?}",
        tokens(&events)
    );
    assert_eq!(after.windows.iter().filter(|w| w.pid == pid).count(), 2);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_second_calculator_process_is_a_new_app_with_a_distinct_id() {
    let mut rig = Rig::new();
    let (first, _) = calculator(&mut rig);
    let seed = capture(&rig, None, None, 10_000).expect("the seed capture");
    let second = rig.spawn("gnome-calculator", &[]);
    assert_ne!(first, second);
    poll("the second calculator window", || {
        (x11_windows(second).len() == 1).then_some(())
    });
    let result = wait_event(&rig, "app-launched", None, OPEN_MS, Some(Ok(seed.clone())));
    assert!(pid_is(found_event(&result), second), "{}", outcome(&result));
    let after = capture(&rig, None, None, 10_000).expect("capture");
    let window_of = |pid| {
        after
            .windows
            .iter()
            .find(|w| w.pid == pid)
            .expect("a window")
    };
    let (one, two) = (window_of(first), window_of(second));
    assert_ne!(one.id, two.id, "the two processes list distinct window ids");
    assert_eq!(one.title, two.title, "both calculators carry one title");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_sigkilled_calculator_is_window_closed_and_app_terminated() {
    let mut rig = Rig::new();
    let (pid, _) = calculator(&mut rig);
    let seed = capture(&rig, None, None, 10_000).expect("the seed capture");
    signal("-KILL", pid);
    let killed = Instant::now();
    let result = wait_event(
        &rig,
        "app-terminated",
        None,
        OPEN_MS,
        Some(Ok(seed.clone())),
    );
    let seen_after = killed.elapsed();
    assert!(pid_is(found_event(&result), pid), "{}", outcome(&result));
    assert!(seen_after < Duration::from_secs(5));
    assert!(process_gone(pid));
    let after = capture(&rig, None, None, 10_000).expect("capture");
    let events = diff(&seed, &after);
    assert_eq!(
        (
            count_of(&events, "window-closed"),
            count_of(&events, "app-terminated")
        ),
        (1, 1),
        "{:?}",
        tokens(&events)
    );
}
