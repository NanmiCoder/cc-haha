use super::*;

#[test]
fn capture_targets_window_for_pid() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let adapter = png_adapter();
    run_ref_action(&context, &adapter, 99).unwrap();
    match adapter.target.lock().unwrap().take() {
        Some(ScreenshotTarget::ExactWindow(window)) => {
            assert_eq!(window.pid, 99);
            assert_eq!(window.id, "w-99");
        }
        _ => panic!("expected exact window screenshot target"),
    }
}
