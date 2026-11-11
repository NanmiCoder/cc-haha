use super::*;
use crate::tree::live::live_launch::nonce;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(nonce(label));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn entry(dir: &Path, file: &str) -> PathBuf {
    std::fs::create_dir_all(dir).expect("applications dir");
    let path = dir.join(file);
    std::fs::write(&path, "[Desktop Entry]\nName=x\n").expect("entry");
    path
}

#[test]
fn the_data_home_comes_before_the_data_dirs_in_their_order() {
    let dirs = applications_dirs(Some("/h"), Some("/a:/b"), Some("/home/u"));
    assert_eq!(
        dirs,
        ["/h/applications", "/a/applications", "/b/applications"].map(PathBuf::from)
    );
}

#[test]
fn an_empty_or_unset_value_falls_back_to_the_default() {
    let dirs = applications_dirs(None, None, Some("/home/u"));
    assert_eq!(
        dirs,
        [
            "/home/u/.local/share/applications",
            "/usr/local/share/applications",
            "/usr/share/applications"
        ]
        .map(PathBuf::from)
    );
    assert_eq!(dirs, applications_dirs(Some(""), Some(""), Some("/home/u")));
}

#[test]
fn a_relative_entry_is_ignored() {
    let dirs = applications_dirs(Some("rel"), Some("x:/a::y"), None);
    assert_eq!(dirs, [PathBuf::from("/a/applications")]);
}

#[test]
fn the_first_file_in_directory_order_wins() {
    let root = scratch("lookup-order");
    let first = entry(&root.join("one"), "app.desktop");
    entry(&root.join("two"), "app.desktop");
    let dirs = [root.join("one"), root.join("two")];
    assert_eq!(find("app", &dirs), Some(first.clone()));
    assert_eq!(find("app.desktop", &dirs), Some(first));
    assert_eq!(find("missing", &dirs), None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_id_with_a_separator_never_leaves_the_directories() {
    let root = scratch("lookup-escape");
    entry(&root.join("outside"), "evil.desktop");
    let dirs = [root.join("apps")];
    std::fs::create_dir_all(&dirs[0]).expect("dir");
    assert_eq!(find("../outside/evil", &dirs), None);
    assert_eq!(find("/etc/passwd", &dirs), None);
    assert_eq!(find("", &dirs), None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn only_a_file_under_the_directories_is_trusted() {
    let dirs = [PathBuf::from("/usr/share/applications")];
    assert!(is_trusted(
        Path::new("/usr/share/applications/a.desktop"),
        &dirs
    ));
    assert!(!is_trusted(Path::new("/tmp/a.desktop"), &dirs));
    assert!(!is_trusted(
        Path::new("/usr/share/applications/../../../tmp/a.desktop"),
        &dirs
    ));
    assert!(!is_trusted(Path::new("a.desktop"), &dirs));
    assert!(!is_trusted(
        Path::new("/usr/share/applications-evil/a.desktop"),
        &dirs
    ));
}

#[test]
fn reading_every_file_keeps_the_first_of_a_shared_id() {
    let root = scratch("lookup-all");
    entry(&root.join("one"), "a.desktop");
    entry(&root.join("one"), "note.txt");
    entry(&root.join("two"), "a.desktop");
    entry(&root.join("two"), "b.desktop");
    let all = read_all(&[root.join("one"), root.join("two")]);
    let ids: Vec<_> = all.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(ids, ["a", "b"]);
    let _ = std::fs::remove_dir_all(root);
}
