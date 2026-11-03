use crate::system::launch::desktop_entry_traits::EntryTraits;

/// The fields of a desktop entry that launching and naming read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) exec: Option<String>,
    pub(crate) try_exec: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) traits: EntryTraits,
}

const GROUP: &str = "[Desktop Entry]";

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn keys_of_group(text: &str) -> Vec<(&str, &str)> {
    let mut inside = false;
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == GROUP;
            continue;
        }
        if !inside || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            pairs.push((key.trim(), value.trim_start()));
        }
    }
    pairs
}

/// Reads the `[Desktop Entry]` group of a desktop file. Localised keys such
/// as `Name[de]` are ignored and the first occurrence of a key wins. Text with
/// no such group, or with no `Name`, is not an entry.
pub(crate) fn parse(id: &str, text: &str) -> Option<DesktopEntry> {
    let pairs = keys_of_group(text);
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(candidate, _)| *candidate == key)
            .map(|(_, value)| unescape(value))
            .filter(|value| !value.trim().is_empty())
    };
    let flag = |key: &str| get(key).is_some_and(|value| value == "true");
    let name = get("Name")?;
    Some(DesktopEntry {
        id: id.to_owned(),
        name,
        exec: get("Exec"),
        try_exec: get("TryExec"),
        path: get("Path"),
        icon: get("Icon"),
        traits: EntryTraits {
            application: get("Type").is_some_and(|kind| kind == "Application"),
            terminal: flag("Terminal"),
            hidden: flag("Hidden"),
            wm_class: get("StartupWMClass"),
        },
    })
}

#[cfg(test)]
#[path = "desktop_entry_tests.rs"]
mod tests;
