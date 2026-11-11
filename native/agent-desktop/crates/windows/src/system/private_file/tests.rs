use std::hash::{BuildHasher, RandomState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "locality_tests.rs"]
mod locality_tests;
#[path = "owner_tests.rs"]
mod owner_tests;

#[path = "owner_token_tests.rs"]
mod owner_token_tests;
#[path = "path_tests.rs"]
mod path_tests;
#[path = "replace_tests.rs"]
mod replace_tests;

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Scratch {
    root: PathBuf,
}
impl Scratch {
    pub(crate) fn new(name: &str) -> Self {
        Self::adopt(std::env::temp_dir().join(format!(
            "agent-desktop-pf-{name}-{}-{:016x}",
            std::process::id(),
            scratch_nonce()
        )))
    }

    pub(super) fn adopt(root: PathBuf) -> Self {
        std::fs::create_dir_all(&root).expect("scratch root must be creatable");
        Self { root }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub(super) fn scratch_nonce() -> u64 {
    RandomState::new().hash_one((
        std::process::id(),
        SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now(),
    ))
}

pub(crate) fn create_junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("cmd /c mklink /J must spawn");
    assert!(status.success(), "junction creation must succeed");
    let created = std::fs::symlink_metadata(link).expect("junction metadata must be readable");
    assert!(
        created.file_type().is_symlink(),
        "the planted link must surface as a reparse point"
    );
}
