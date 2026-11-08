use std::path::PathBuf;

/// The environment the choice reads. An empty value counts as unset (L13-2).
#[derive(Debug, Clone, Default)]
pub(crate) struct DisplayEnv {
    pub(crate) wayland: Option<String>,
    pub(crate) display: Option<String>,
    pub(crate) runtime_dir: Option<PathBuf>,
}

impl DisplayEnv {
    pub(crate) fn from_process() -> Self {
        let text = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            wayland: text("WAYLAND_DISPLAY"),
            display: text("DISPLAY"),
            runtime_dir: text("XDG_RUNTIME_DIR").map(PathBuf::from),
        }
    }
}
