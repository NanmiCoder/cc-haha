use crate::trace::trace_read::{ExportOptions, export_html};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const SEGMENT_LINE: &str = r#"{"event":"command.start","command":"snapshot","ts_ms":1,"seq":1}"#;
const SESSION_ID: &str = "s-export-write";
const SENTINEL: &[u8] = b"planted-sentinel";
const LEGACY_COUNTER_RANGE: u64 = 16;

fn export_test_guard() -> std::sync::MutexGuard<'static, ()> {
    let lock = super::tests::html_test_guard();
    super::clear_test_max_json_bytes();
    lock
}

fn export_scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-export-{label}-{}",
        crate::refs::new_snapshot_id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn trace_dir_with_one_event(root: &Path) -> PathBuf {
    let trace_dir = root.join("trace");
    fs::create_dir_all(&trace_dir).unwrap();
    let mut file = fs::File::create(trace_dir.join("100-1000.jsonl")).unwrap();
    writeln!(file, "{SEGMENT_LINE}").unwrap();
    trace_dir
}

fn export_to(trace_dir: &Path, out: &Path) -> Result<(), crate::AppError> {
    export_html(
        trace_dir,
        SESSION_ID,
        &ExportOptions {
            limit: 0,
            out: Some(out.to_path_buf()),
        },
    )
    .map(|_| ())
}

fn legacy_temporary_path(out: &Path, counter: u64) -> PathBuf {
    out.with_extension(format!("{}.{counter}.tmp", std::process::id()))
}

#[test]
fn export_refuses_a_directory_destination() {
    let _guard = export_test_guard();
    let root = export_scratch("directory-destination");
    let trace_dir = trace_dir_with_one_event(&root);
    let out = root.join("report.html");
    fs::create_dir(&out).unwrap();

    let error = export_to(&trace_dir, &out).unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(out.is_dir());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn export_path_inside_a_file_is_an_argument_error() {
    let _guard = export_test_guard();
    let root = export_scratch("blocked-parent");
    let trace_dir = trace_dir_with_one_event(&root);
    let blocker = root.join("blocker");
    fs::write(&blocker, b"file").unwrap();
    let out = blocker.join("report.html");

    let error = export_to(&trace_dir, &out).unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(error.to_string().contains(&format!(
        "Cannot write the trace export to '{}'",
        out.display()
    )));
    let crate::AppError::Adapter(error) = error else {
        panic!("expected structured argument error")
    };
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), crate::RetryDisposition::Safe);
    assert!(error.suggestion.is_some());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn export_refuses_a_symlink_destination() {
    let _guard = export_test_guard();
    let root = export_scratch("symlink-destination");
    let trace_dir = trace_dir_with_one_event(&root);
    let target = root.join("target.html");
    fs::write(&target, b"kept").unwrap();
    let out = root.join("report.html");
    std::os::unix::fs::symlink(&target, &out).unwrap();

    let error = export_to(&trace_dir, &out).unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGS");
    assert_eq!(fs::read(&target).unwrap(), b"kept");
    assert!(out.is_symlink());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn export_does_not_write_through_the_legacy_predictable_temporary_name() {
    let _guard = export_test_guard();
    let root = export_scratch("legacy-temporary");
    let trace_dir = trace_dir_with_one_event(&root);
    let out = root.join("report.html");
    let planted: Vec<PathBuf> = (0..LEGACY_COUNTER_RANGE)
        .map(|counter| legacy_temporary_path(&out, counter))
        .collect();
    for path in &planted {
        fs::write(path, SENTINEL).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o666)).unwrap();
        }
    }

    export_to(&trace_dir, &out).unwrap();

    assert!(out.is_file());
    for path in &planted {
        assert!(
            path.is_file(),
            "the export consumed the predictable temporary name {}",
            path.display()
        );
        assert_eq!(
            fs::read(path).unwrap(),
            SENTINEL,
            "the export overwrote the predictable temporary name {}",
            path.display()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o666,
                "the export re-permissioned the predictable temporary name {}",
                path.display()
            );
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_successful_export_leaves_no_temporary_residue() {
    let _guard = export_test_guard();
    let root = export_scratch("no-residue");
    let trace_dir = trace_dir_with_one_event(&root);
    let out = root.join("report.html");

    export_to(&trace_dir, &out).unwrap();

    let mut names: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["report.html".to_string(), "trace".to_string()]);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn an_exported_file_lands_owner_only_under_an_explicit_out_path() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = export_test_guard();
    let root = export_scratch("owner-only");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    let trace_dir = trace_dir_with_one_event(&root);
    let out = root.join("report.html");

    export_to(&trace_dir, &out).unwrap();

    assert_eq!(
        fs::metadata(&out).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::remove_dir_all(root).unwrap();
}
