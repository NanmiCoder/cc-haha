use super::AppNames;

fn store(name: &str) -> (AppNames, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ad-names-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (AppNames { dir: dir.clone() }, dir)
}

#[test]
fn a_remembered_name_comes_back_for_the_same_bus_and_instance_only() {
    let (names, dir) = store("round");
    names.remember(":1.42", "boot:1", "QtApp");
    assert_eq!(names.recall(":1.42", "boot:1").as_deref(), Some("QtApp"));
    assert_eq!(names.recall(":1.42", "boot:2"), None);
    assert_eq!(names.recall(":1.43", "boot:1"), None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_new_name_for_a_reused_bus_name_replaces_the_old_one() {
    let (names, dir) = store("replace");
    names.remember(":1.42", "boot:1", "First");
    names.remember(":1.42", "boot:1", "Second");
    assert_eq!(names.recall(":1.42", "boot:1").as_deref(), Some("Second"));
    let _ = std::fs::remove_dir_all(dir);
}
