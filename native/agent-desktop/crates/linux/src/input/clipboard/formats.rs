use agent_desktop_core::{AdapterError, ErrorCode};

use super::target::Target;

pub(crate) const UTF8_STRING: &str = "UTF8_STRING";
pub(crate) const TEXT_UTF8: &str = "text/plain;charset=utf-8";
pub(crate) const TEXT_PLAIN: &str = "text/plain";
pub(crate) const STRING: &str = "STRING";
pub(crate) const URI_LIST: &str = "text/uri-list";
pub(crate) const GNOME_FILES: &str = "x-special/gnome-copied-files";
pub(crate) const PNG: &str = "image/png";

pub(crate) const TEXT_TARGETS: [&str; 4] = [UTF8_STRING, TEXT_UTF8, TEXT_PLAIN, STRING];

/// Decodes the bytes an owner sent for one text target. The UTF-8 targets are
/// strict: invalid bytes are an error and never replaced. `STRING` is
/// Latin-1, which maps every byte to the code point of the same value.
pub(crate) fn decode_text(target: &str, bytes: &[u8]) -> Result<String, AdapterError> {
    match target {
        STRING => Ok(bytes.iter().map(|byte| char::from(*byte)).collect()),
        _ => std::str::from_utf8(bytes).map(str::to_owned).map_err(|_| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                format!("The clipboard's {target} text is not valid UTF-8"),
            )
            .with_suggestion("Copy the text again from an application that offers UTF-8")
        }),
    }
}

/// The text targets one owner serves for `text`. `STRING` is offered only
/// when every character fits Latin-1, so a reader of it never gets a
/// substituted character.
pub(crate) fn encode_text_targets(text: &str) -> Vec<Target> {
    let mut targets: Vec<Target> = TEXT_TARGETS[..3]
        .iter()
        .map(|name| Target {
            name: (*name).to_owned(),
            bytes: text.as_bytes().to_vec(),
        })
        .collect();
    let latin1: Option<Vec<u8>> = text
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect();
    if let Some(bytes) = latin1 {
        targets.push(Target {
            name: STRING.to_owned(),
            bytes,
        });
    }
    targets
}

#[cfg(test)]
#[path = "formats_tests.rs"]
mod tests;
