use std::path::PathBuf;

use crate::system::app::runtime_store::{instance_stem, runtime_subdir, write_private_atomically};

const IDS_DIR: &str = "agent-desktop-window-ids";

/// The ids windows were listed under, kept per X11 client and process
/// instance in a private directory of the runtime dir. A process that has
/// stopped cannot be asked for its frames, so the id a caller took before the
/// stop is read back from here instead of being made up.
pub(in crate::system) struct WindowIds {
    dir: PathBuf,
}

impl WindowIds {
    pub(in crate::system) fn in_runtime_dir() -> Option<Self> {
        runtime_subdir(IDS_DIR).map(Self::at)
    }

    pub(in crate::system) fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, client: u32, instance: &str) -> PathBuf {
        self.dir.join(instance_stem(client, instance))
    }

    pub(in crate::system) fn remember(&self, client: u32, instance: &str, id: &str) {
        let path = self.path(client, instance);
        if std::fs::read_to_string(&path).is_ok_and(|known| known == id) {
            return;
        }
        let _ = write_private_atomically(&self.dir, &path, id.as_bytes());
    }

    pub(in crate::system) fn recall(&self, client: u32, instance: &str) -> Option<String> {
        std::fs::read_to_string(self.path(client, instance))
            .ok()
            .filter(|id| !id.is_empty())
    }
}

#[cfg(test)]
#[path = "window_ids_tests.rs"]
mod tests;
