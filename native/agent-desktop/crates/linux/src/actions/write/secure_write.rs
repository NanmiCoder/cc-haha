use agent_desktop_core::AdapterError;

use super::text_write::TextPort;
use crate::tree::vocabulary::role_numbers::PASSWORD_TEXT;

const SECURE_TOKEN: &str = "secure";

pub(crate) fn is_secure(role: Option<u32>, tokens: Option<&[String]>, flagged: bool) -> bool {
    flagged
        || role == Some(PASSWORD_TEXT)
        || tokens.is_some_and(|words| words.iter().any(|word| word == SECURE_TOKEN))
}

pub(crate) fn guarded_read(port: &dyn TextPort, secure: bool) -> Option<String> {
    if secure { None } else { port.read() }
}

pub(crate) fn scrub(mut error: AdapterError, written: &str, secure: bool) -> AdapterError {
    if !secure || written.is_empty() {
        return error;
    }
    let redact = |field: &mut String| {
        if field.contains(written) {
            *field = field.replace(written, "[withheld]");
        }
    };
    redact(&mut error.message);
    error.suggestion.iter_mut().for_each(redact);
    error.platform_detail.iter_mut().for_each(redact);
    let echoed = error
        .details
        .as_ref()
        .is_some_and(|details| details.to_string().contains(written));
    if echoed {
        error.details = None;
    }
    error
}

#[cfg(test)]
#[path = "secure_write_tests.rs"]
mod tests;
