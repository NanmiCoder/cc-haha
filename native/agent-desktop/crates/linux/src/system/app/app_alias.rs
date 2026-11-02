use crate::system::app::alias_cache::AliasCache;
use crate::system::launch::indexed_entry::IndexedEntry;
use std::path::PathBuf;
use std::sync::Arc;

use crate::system::launch::desktop_entry::parse;
use crate::system::launch::desktop_exec::{ExecContext, expand};
use crate::system::launch::desktop_lookup::{current_dirs, find};
use crate::system::process::executable_identity::ExecutableIdentity;

/// The desktop entries of the machine, as the names each executable goes by.
pub(crate) struct AliasIndex {
    entries: Vec<IndexedEntry>,
}

impl AliasIndex {
    pub(in crate::system) fn build(files: &[(String, String)], dirs: &[PathBuf]) -> Self {
        let entries = files
            .iter()
            .filter_map(|(id, text)| parse(id, text))
            .filter(|entry| entry.traits.application && !entry.traits.hidden)
            .map(|entry| {
                let argv = entry
                    .exec
                    .as_deref()
                    .map(|exec| {
                        let file =
                            find(&entry.id, dirs).map(|file| file.to_string_lossy().into_owned());
                        if exec.contains("%k") && file.is_none() {
                            return Vec::new();
                        }
                        expand(
                            exec,
                            &ExecContext {
                                arguments: &[],
                                icon: entry.icon.as_deref(),
                                name: &entry.name,
                                file: file.as_deref(),
                            },
                        )
                    })
                    .unwrap_or_default();
                IndexedEntry {
                    id: entry.id,
                    name: entry.name,
                    argv,
                }
            })
            .collect();
        Self { entries }
    }

    /// Aliases require a single desktop entry whose resolved executable and
    /// full argv match the verified process.
    pub(crate) fn names_for(&self, actual: &ExecutableIdentity) -> Vec<String> {
        self.unique_entry(actual)
            .filter(|entry| {
                self.entries
                    .iter()
                    .filter(|other| other.name.eq_ignore_ascii_case(&entry.name))
                    .count()
                    == 1
            })
            .map(|entry| vec![entry.name.clone()])
            .unwrap_or_default()
    }

    pub(crate) fn ids_for(&self, actual: &ExecutableIdentity) -> Vec<String> {
        self.unique_entry(actual)
            .map(|entry| vec![entry.id.clone()])
            .unwrap_or_default()
    }

    fn unique_entry(&self, actual: &ExecutableIdentity) -> Option<&IndexedEntry> {
        let path = crate::system::launch::launch_search::Search::from_env().path_dirs;
        let mut entries = self.entries.iter().filter(|entry| {
            ExecutableIdentity::requested(&entry.argv, &path)
                .is_some_and(|wanted| wanted.matches(actual))
        });
        match (entries.next(), entries.next()) {
            (Some(entry), None) => Some(entry),
            _ => None,
        }
    }

    /// The id of every entry whose `Name` equals `name`, ignoring case.
    pub(crate) fn ids_named(&self, name: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.name.eq_ignore_ascii_case(name))
            .map(|entry| entry.id.clone())
            .collect()
    }
}

static CACHE: AliasCache = AliasCache::new();

/// The index of the entries the process environment names.
pub(crate) fn current_index() -> Arc<AliasIndex> {
    CACHE.index(&current_dirs())
}

#[cfg(test)]
#[path = "app_alias_tests.rs"]
mod tests;
