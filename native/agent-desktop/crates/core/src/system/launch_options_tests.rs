use super::*;

#[test]
fn default_preserves_attach_if_running_semantics() {
    let options = LaunchOptions::default();

    assert!(
        options.attach_if_running,
        "default LaunchOptions must attach to an already-running instance, matching \
         launch_app's historical behavior; a derived Default would silently flip this to \
         false and turn every unmodified caller into a --no-attach launch"
    );
    assert!(options.args.is_empty());
    assert!(options.env.is_empty());
    assert!(options.cwd.is_none());
}

#[test]
fn explicit_no_attach_overrides_the_default() {
    let options = LaunchOptions {
        attach_if_running: false,
        ..Default::default()
    };

    assert!(!options.attach_if_running);
}
