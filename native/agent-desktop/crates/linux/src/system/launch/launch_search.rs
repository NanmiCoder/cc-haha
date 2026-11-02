use super::desktop_lookup::{absolute_dirs, current_dirs};
use std::path::PathBuf;

/// The directories an identifier is looked up in.
pub(crate) struct Search {
    pub(crate) data_dirs: Vec<PathBuf>,
    pub(crate) path_dirs: Vec<PathBuf>,
}

impl Search {
    pub(crate) fn from_env() -> Self {
        let path = std::env::var("PATH").unwrap_or_default();
        Self {
            data_dirs: current_dirs(),
            path_dirs: absolute_dirs(&path).collect(),
        }
    }
}
