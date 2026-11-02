use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::system::app::runtime_store::{instance_stem, runtime_subdir, write_private_atomically};
use crate::tree::Extents;

const PLACE_DIR: &str = "agent-desktop-window-places";
const STALE_PENDING: std::time::Duration = std::time::Duration::from_secs(60);

/// The client rectangles windows had before they were maximized, kept in a
/// private directory of the runtime dir (mode 0700, files 0600). An entry is
/// keyed by the window id and the start-time token of the owning process, so
/// a reused window id never matches, and entries of processes that are gone
/// are dropped on every save.
pub(super) struct PlaceStore {
    dir: PathBuf,
}

impl PlaceStore {
    pub(super) fn in_runtime_dir() -> Option<Self> {
        runtime_subdir(PLACE_DIR).map(Self::at)
    }

    pub(super) fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, window: u32, instance: &str) -> PathBuf {
        self.dir
            .join(format!("{}.json", instance_stem(window, instance)))
    }

    pub(super) fn save(
        &self,
        window: u32,
        pid: u32,
        instance: &str,
        place: Extents,
        alive: &dyn Fn(u32, &str) -> bool,
    ) -> std::io::Result<()> {
        self.sweep(alive);
        let record = json!({
            "pid": pid,
            "instance": instance,
            "x": place.x,
            "y": place.y,
            "width": place.width,
            "height": place.height,
        });
        write_private_atomically(
            &self.dir,
            &self.path(window, instance),
            record.to_string().as_bytes(),
        )
    }

    pub(super) fn load(&self, window: u32, instance: &str) -> Option<Extents> {
        let value: Value =
            serde_json::from_slice(&std::fs::read(self.path(window, instance)).ok()?).ok()?;
        let field = |name: &str| i32::try_from(value[name].as_i64()?).ok();
        (value["instance"].as_str() == Some(instance)).then_some(())?;
        Some(Extents {
            x: field("x")?,
            y: field("y")?,
            width: field("width")?,
            height: field("height")?,
        })
    }

    pub(super) fn forget(&self, window: u32, instance: &str) {
        let _ = std::fs::remove_file(self.path(window, instance));
    }

    fn sweep(&self, alive: &dyn Fn(u32, &str) -> bool) {
        let Ok(listing) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for file in listing.flatten() {
            let path = file.path();
            if is_stale_pending(&path) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if !is_record(&path) {
                continue;
            }
            let owner = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|value| {
                    let pid = u32::try_from(value["pid"].as_u64()?).ok()?;
                    Some((pid, value["instance"].as_str()?.to_owned()))
                });
            if owner.is_none_or(|(pid, instance)| !alive(pid, &instance)) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn is_stale_pending(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension == "tmp")
        && std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_PENDING)
}

fn is_record(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "json")
}

#[cfg(test)]
#[path = "window_place_tests.rs"]
mod tests;
