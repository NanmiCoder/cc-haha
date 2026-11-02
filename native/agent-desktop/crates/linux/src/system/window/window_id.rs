use agent_desktop_core::{AdapterError, ErrorCode};

const PREFIX: &str = "w-";
const BUS_SEPARATOR: char = '-';
const PATH_SEPARATOR: char = '/';
const PATH_ESCAPE: char = '-';

fn is_unique_bus_name(bus: &str) -> bool {
    bus.strip_prefix(':')
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(first, second)| {
            [first, second]
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
}

fn is_object_path(path: &str) -> bool {
    path.strip_prefix(PATH_SEPARATOR).is_some_and(|rest| {
        !rest.is_empty()
            && rest.split(PATH_SEPARATOR).all(|element| {
                !element.is_empty()
                    && element
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
    })
}

/// The window id of the frame at `path` on the unique bus name `bus`, or
/// `None` when either is not in the form the bus daemon and the object path
/// rules allow. The id is shell-safe, stateless, and distinct per frame: it
/// is the address itself, so two same-titled windows of one application differ.
pub(crate) fn encode(bus: &str, path: &str) -> Option<String> {
    (is_unique_bus_name(bus) && is_object_path(path)).then(|| {
        let elements = path[1..].replace(PATH_SEPARATOR, &PATH_ESCAPE.to_string());
        format!("{PREFIX}{}{BUS_SEPARATOR}{elements}", &bus[1..])
    })
}

fn invalid(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("'{id}' is not a window id this adapter issued"),
    )
    .with_suggestion("Run 'list-windows' and use the id it reports")
}

/// The bus name and object path an id was made from. Anything that is not
/// exactly the form `encode` produces is rejected.
pub(crate) fn decode(id: &str) -> Result<(String, String), AdapterError> {
    let rest = id.strip_prefix(PREFIX).ok_or_else(|| invalid(id))?;
    let (bus, elements) = rest.split_once(BUS_SEPARATOR).ok_or_else(|| invalid(id))?;
    let bus = format!(":{bus}");
    let path = format!("{PATH_SEPARATOR}{}", elements.replace(PATH_ESCAPE, "/"));
    match encode(&bus, &path).as_deref() == Some(id) {
        true => Ok((bus, path)),
        false => Err(invalid(id)),
    }
}

#[cfg(test)]
#[path = "window_id_tests.rs"]
mod tests;
