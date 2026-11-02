const DEFAULT_PATH: &str = "/StatusNotifierItem";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Registration {
    pub(crate) bus_name: String,
    pub(crate) object_path: String,
}

fn valid_bus_name(name: &str) -> bool {
    let shaped = name.starts_with(':') || name.contains('.');
    shaped
        && name.len() <= 255
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':'))
}

fn valid_object_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("//")
        && (path == "/" || !path.ends_with('/'))
        && path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '/'))
}

fn registration(name: &str, path: &str) -> Option<Registration> {
    (valid_bus_name(name) && valid_object_path(path)).then(|| Registration {
        bus_name: name.to_owned(),
        object_path: path.to_owned(),
    })
}

pub(crate) fn parse(text: &str) -> Option<Registration> {
    let text = text.trim();
    if let Some((name, path)) = text.split_once('@') {
        return registration(name, path);
    }
    match text.find('/') {
        Some(0) => None,
        Some(split) => registration(&text[..split], &text[split..]),
        None => registration(text, DEFAULT_PATH),
    }
}

pub(crate) fn parse_all(listed: &[String]) -> Vec<Registration> {
    let mut seen: Vec<Registration> = Vec::new();
    for text in listed {
        let Some(parsed) = parse(text) else { continue };
        let duplicate = seen.iter().any(|known| {
            known.bus_name == parsed.bus_name && known.object_path == parsed.object_path
        });
        if !duplicate {
            seen.push(parsed);
        }
    }
    seen
}

#[cfg(test)]
#[path = "registration_tests.rs"]
mod tests;
