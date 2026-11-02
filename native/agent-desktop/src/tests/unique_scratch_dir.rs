use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Mints a process-unique temp directory for a test fixture's private scratch
/// root and creates it. `prefix` names the fixture family (e.g. `"install"`,
/// `"overlay"`); `label` names the individual case within that family.
pub(crate) fn unique_scratch_dir(prefix: &str, label: &str) -> PathBuf {
    static SCRATCH_ID: AtomicU64 = AtomicU64::new(1);
    let id = SCRATCH_ID.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "agent-desktop-{prefix}-{label}-{}-{id}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).expect("create scratch root");
    root
}
