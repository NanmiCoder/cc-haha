use super::*;

#[test]
fn an_answering_registry_app_without_frames_adds_no_population_or_signals() {
    let before = World::new(vec![app(1, "calc", true)], vec![window(0, "w-1")]);
    let after = World::new(
        vec![app(1, "calc", true), app(2, "gnome-terminal-server", true)],
        vec![window(0, "w-1")],
    );
    let first = take(&before, &SignalFilter::default());
    let second = take(&after, &SignalFilter::default());
    assert_eq!(*after.reads.roots_read.borrow(), [0, 1]);
    assert_eq!(second.apps.len(), 1);
    assert!(second.apps.iter().all(|app| app.pid != 102));
    assert!(second.windows.iter().all(|window| window.pid != 102));
    assert!(diff_signals(&first, &second).is_empty());
}
