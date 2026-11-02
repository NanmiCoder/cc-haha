use std::fs;
use std::path::{Path, PathBuf};

const BANNED: [&str; 4] = ["bus::classify", "classify_at", "gone_error", "read_failure"];

fn offences(source: &str) -> Vec<&'static str> {
    BANNED
        .iter()
        .copied()
        .filter(|banned| source.contains(banned))
        .collect()
}

fn collect_sources(root: &Path, dir: &Path, sources: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).expect("an actions directory reads") {
        let path = entry.expect("an entry reads").path();
        if path.is_dir() {
            collect_sources(root, &path, sources);
            continue;
        }
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if file.ends_with(".rs") && !file.ends_with("_tests.rs") {
            let name = path
                .strip_prefix(root)
                .expect("a source sits under the actions root")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let text = fs::read_to_string(&path).expect("a source reads");
            sources.push((name, text));
        }
    }
}

fn shipped_sources() -> Vec<(String, String)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/actions");
    let mut sources = Vec::new();
    collect_sources(&root, &root, &mut sources);
    sources
}

#[test]
fn no_action_file_reaches_a_read_path_mapper_or_a_banned_call() {
    let sources = shipped_sources();
    assert!(sources.len() > 10, "the scan must see the action files");
    for required in ["select_row.rs", "scroll_plan.rs", "text_write.rs"] {
        assert!(
            sources
                .iter()
                .any(|(name, _)| name.rsplit('/').next() == Some(required)),
            "the scan must reach {required}"
        );
    }
    for (name, text) in sources {
        assert!(offences(&text).is_empty(), "{name}: {:?}", offences(&text));
    }
}
