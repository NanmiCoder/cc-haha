use super::*;
use crate::system::process::executable_identity::ExecutableIdentity;

fn file(id: &str, name: &str, exec: &str) -> (String, String) {
    (
        id.into(),
        format!("[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\n"),
    )
}

#[test]
fn desktop_aliases_require_unique_verified_executable_identity() {
    let actual = ExecutableIdentity::read(std::process::id()).expect("own identity");
    let command = actual
        .argv
        .as_ref()
        .unwrap()
        .iter()
        .map(|word| {
            format!(
                "\"{}\"",
                word.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let executable = command.as_str();
    let entry = file("owned", "Owned App", executable);
    let index = AliasIndex::build(std::slice::from_ref(&entry), &[]);
    assert_eq!(index.names_for(&actual), ["Owned App"]);
    assert_eq!(index.ids_for(&actual), ["owned"]);
    let mut path_launched = actual.clone();
    let invocation = &mut path_launched.argv.as_mut().unwrap()[0];
    *invocation = std::path::Path::new(invocation).file_name().unwrap().into();
    assert_eq!(index.names_for(&path_launched), ["Owned App"]);
    let index = AliasIndex::build(&[entry, file("duplicate", "Another App", executable)], &[]);
    assert!(index.names_for(&actual).is_empty());
    assert!(index.ids_for(&actual).is_empty());
    let index = AliasIndex::build(&[file("wrong", "Wrong App", "/missing/elsewhere")], &[]);
    assert!(index.names_for(&actual).is_empty());
}

#[test]
fn a_sole_desktop_interpreter_never_aliases_another_script() {
    let mut child = std::process::Command::new("/usr/bin/python3")
        .args(["-c", "import time; time.sleep(30)"])
        .spawn()
        .unwrap();
    let actual = loop {
        let actual = ExecutableIdentity::read(child.id()).unwrap();
        if actual
            .executable
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("python")
        {
            break actual;
        }
        std::thread::yield_now();
    };
    let index = AliasIndex::build(
        &[file("one", "App One", "/usr/bin/python3 /opt/one.py")],
        &[],
    );
    let names = index.names_for(&actual);
    let ids = index.ids_for(&actual);
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(names.is_empty());
    assert!(ids.is_empty());
}

#[test]
fn a_desktop_name_shared_by_different_executables_has_no_alias() {
    let actual = ExecutableIdentity::read(std::process::id()).unwrap();
    let command = actual
        .argv
        .as_ref()
        .unwrap()
        .iter()
        .map(|word| {
            format!(
                "\"{}\"",
                word.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let executable = command.as_str();
    let index = AliasIndex::build(
        &[
            file("one", "Editor", executable),
            file("two", "EDITOR", "/bin/true"),
        ],
        &[],
    );
    assert!(index.names_for(&actual).is_empty());
    assert_eq!(index.ids_for(&actual), ["one"]);
}

#[test]
fn an_in_place_desktop_edit_invalidates_the_previous_executable_alias() {
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};
    let dir = std::env::temp_dir().join(crate::tree::live::live_launch::nonce("alias-cache"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("owned.desktop");
    let command = "/bin/sleep 30";
    let actual = ExecutableIdentity::requested(&["/bin/sleep".into(), "30".into()], &[]).unwrap();
    std::fs::write(&path, file("owned", "Before", command).1).unwrap();
    let cache = AliasCache::new();
    let dirs = [dir.clone()];
    let before = cache.index(&dirs);
    assert_eq!(before.names_for(&actual), ["Before"]);
    assert!(Arc::ptr_eq(&before, &cache.index(&dirs)));
    let length_before = std::fs::metadata(&path).unwrap().len();
    let directory_before = std::fs::metadata(&dir).unwrap().modified().unwrap();
    std::fs::write(&path, file("owned", "After!", "/bin/false 00").1).unwrap();
    std::fs::File::open(&path)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(60))
        .unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), length_before);
    let after = cache.index(&dirs);
    assert_eq!(
        std::fs::metadata(&dir).unwrap().modified().unwrap(),
        directory_before
    );
    assert!(
        after.names_for(&actual).is_empty(),
        "old executable loses the edited alias"
    );
    let replacement =
        ExecutableIdentity::requested(&["/bin/false".into(), "00".into()], &[]).unwrap();
    assert_eq!(after.names_for(&replacement), ["After!"]);
    assert!(!Arc::ptr_eq(&before, &after));
    std::fs::remove_dir_all(dir).unwrap();
}
