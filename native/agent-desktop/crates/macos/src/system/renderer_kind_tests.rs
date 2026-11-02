use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

/// A throwaway `<Name>.app` fixture under the system temp directory, removed
/// on drop so a panicking test does not litter it behind.
struct FixtureBundle {
    root: PathBuf,
}

impl FixtureBundle {
    fn new() -> Self {
        let mut root = std::env::temp_dir();
        root.push(format!(
            "agent-desktop-renderer-kind-test-{}-{}",
            std::process::id(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        root.push("Fixture.app");
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn add_framework(&self, name: &str) {
        let frameworks = self.root.join("Contents/Frameworks");
        std::fs::create_dir_all(&frameworks).unwrap();
        std::fs::create_dir_all(frameworks.join(name)).unwrap();
    }

    fn add_empty_contents(&self) {
        std::fs::create_dir_all(self.root.join("Contents")).unwrap();
    }
}

impl Drop for FixtureBundle {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.root.parent().unwrap());
    }
}

#[test]
fn chromium_marker_in_bundle_is_true_for_an_electron_framework_entry() {
    let bundle = FixtureBundle::new();
    bundle.add_framework("Electron Framework.framework");

    assert!(chromium_marker_in_bundle(&bundle.root));
}

#[test]
fn chromium_marker_in_bundle_is_false_without_a_matching_framework() {
    let bundle = FixtureBundle::new();
    bundle.add_framework("Sparkle.framework");

    assert!(!chromium_marker_in_bundle(&bundle.root));
}

#[test]
fn chromium_marker_in_bundle_is_false_when_frameworks_dir_is_missing() {
    let bundle = FixtureBundle::new();
    bundle.add_empty_contents();

    assert!(!chromium_marker_in_bundle(&bundle.root));
}

#[test]
fn bundle_root_is_derived_from_the_conventional_executable_layout() {
    let executable = Path::new("/Applications/Fixture.app/Contents/MacOS/Fixture");

    assert_eq!(
        bundle_root_from_executable(executable),
        Some(PathBuf::from("/Applications/Fixture.app"))
    );
}

#[test]
fn bundle_root_is_none_for_a_bare_executable_outside_any_bundle() {
    assert_eq!(
        bundle_root_from_executable(Path::new("/usr/bin/fixture")),
        None
    );
}

#[test]
fn bundle_root_is_none_when_the_macos_directory_is_missing() {
    let executable = Path::new("/Applications/Fixture.app/Contents/Fixture");

    assert_eq!(bundle_root_from_executable(executable), None);
}

#[test]
fn bundle_root_is_none_when_the_containing_directory_is_not_an_app_bundle() {
    let executable = Path::new("/opt/Fixture/Contents/MacOS/Fixture");

    assert_eq!(bundle_root_from_executable(executable), None);
}

#[test]
fn electron_and_cef_framework_names_are_recognized_exactly() {
    assert!(is_chromium_framework_marker("Electron Framework.framework"));
    assert!(is_chromium_framework_marker(
        "Chromium Embedded Framework.framework"
    ));
}

#[test]
fn unrelated_or_partial_framework_names_are_not_recognized() {
    assert!(!is_chromium_framework_marker("Sparkle.framework"));
    assert!(!is_chromium_framework_marker("Electron Framework"));
    assert!(!is_chromium_framework_marker(
        "electron framework.framework"
    ));
}
