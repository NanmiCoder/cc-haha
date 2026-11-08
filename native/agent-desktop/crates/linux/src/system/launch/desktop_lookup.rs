use super::desktop_stamp::DesktopStamp;
use std::path::{Component, Path, PathBuf};

const SUFFIX: &str = ".desktop";
const DEFAULT_DATA_DIRS: &str = "/usr/local/share:/usr/share";
const DEFAULT_DATA_HOME: &str = ".local/share";
const APPLICATIONS: &str = "applications";

pub(crate) fn absolute_dirs(list: &str) -> impl Iterator<Item = PathBuf> + '_ {
    list.split(':')
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
}

/// The directories desktop entries are read from, in the order of the
/// XDG Base Directory Specification: the data home, then each data directory.
/// An empty value falls back to the default, and a relative entry is ignored,
/// as the specification says.
pub(crate) fn applications_dirs(
    data_home: Option<&str>,
    data_dirs: Option<&str>,
    home: Option<&str>,
) -> Vec<PathBuf> {
    let home_dir = data_home
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|dir| !dir.is_empty())
                .map(|dir| Path::new(dir).join(DEFAULT_DATA_HOME))
        })
        .filter(|dir| dir.is_absolute());
    let system = data_dirs
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or(DEFAULT_DATA_DIRS);
    home_dir
        .into_iter()
        .chain(absolute_dirs(system))
        .map(|dir| dir.join(APPLICATIONS))
        .collect()
}

/// The directories for the environment of this process.
pub(crate) fn current_dirs() -> Vec<PathBuf> {
    let var = |name: &str| std::env::var(name).ok();
    applications_dirs(
        var("XDG_DATA_HOME").as_deref(),
        var("XDG_DATA_DIRS").as_deref(),
        var("HOME").as_deref(),
    )
}

/// The id a desktop file name carries: the name without its suffix.
pub(crate) fn id_of(file_name: &str) -> Option<&str> {
    file_name
        .strip_suffix(SUFFIX)
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

/// The first `<id>.desktop` under the directories. An id that holds a path
/// separator or a NUL is never joined to a directory, so no id reaches a file
/// outside them.
pub(crate) fn find(id: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let id = id.strip_suffix(SUFFIX).unwrap_or(id);
    if id.is_empty() || id.contains('/') || id.contains('\0') {
        return None;
    }
    dirs.iter()
        .map(|dir| dir.join(format!("{id}{SUFFIX}")))
        .find(|file| file.is_file())
}

/// Whether a desktop file lies under one of the directories. A path with a
/// `..` component is never trusted, so it cannot climb out of them.
pub(crate) fn is_trusted(file: &Path, dirs: &[PathBuf]) -> bool {
    file.is_absolute()
        && file.components().all(|part| part != Component::ParentDir)
        && dirs.iter().any(|dir| file.starts_with(dir))
}

/// Every readable desktop file under the directories as its id and text. The
/// first file for an id wins, in directory order, as in `find`.
pub(crate) fn read_all(dirs: &[PathBuf]) -> Vec<(String, String)> {
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for dir in dirs {
        let Ok(listing) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut names: Vec<_> = listing
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names {
            let Some(id) = id_of(&name) else { continue };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(dir.join(&name)) {
                entries.push((id.to_owned(), text));
            }
        }
    }
    entries
}

/// Directory and entry versions, including in-place desktop file edits.
pub(crate) fn stamps(dirs: &[PathBuf]) -> Vec<DesktopStamp> {
    dirs.iter()
        .flat_map(|dir| {
            let mut files: Vec<_> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    id_of(entry.file_name().to_str()?)?;
                    Some(entry.path())
                })
                .collect();
            files.sort();
            std::iter::once(dir.clone()).chain(files)
        })
        .map(DesktopStamp::read)
        .collect()
}

#[cfg(test)]
#[path = "desktop_lookup_tests.rs"]
mod tests;
