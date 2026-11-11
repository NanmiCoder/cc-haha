use agent_desktop_core::{AdapterError, ErrorCode};

fn malformed(why: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The clipboard's file list is malformed: {why}"),
    )
}

fn hex(digit: u8) -> Option<u8> {
    char::from(digit)
        .to_digit(16)
        .and_then(|value| u8::try_from(value).ok())
}

fn percent_decode(text: &str) -> Result<String, AdapterError> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = bytes.get(at + 1).copied().and_then(hex);
            let low = bytes.get(at + 2).copied().and_then(hex);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(malformed("an invalid percent sequence"));
            };
            out.push(high * 16 + low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).map_err(|_| malformed("a path that is not UTF-8"))
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/')
}

fn percent_encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if is_unreserved(byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn path_of_uri(line: &str) -> Result<Option<String>, AdapterError> {
    let Some(rest) = line.strip_prefix("file://") else {
        return Ok(None);
    };
    let slash = rest.find('/');
    let (host, path) = match slash {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) || path.is_empty() {
        return Ok(None);
    }
    percent_decode(path).map(Some)
}

/// Parses a `text/uri-list` into local paths. Comment lines, remote hosts and
/// entries that are not `file:` URIs are skipped; a list with no usable
/// entry is an empty list. An invalid percent sequence is an error.
pub(crate) fn parse_uri_list(bytes: &[u8]) -> Result<Vec<String>, AdapterError> {
    let text = std::str::from_utf8(bytes).map_err(|_| malformed("text that is not UTF-8"))?;
    let mut paths = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(path) = path_of_uri(line)? {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Parses `x-special/gnome-copied-files`: an optional `copy` or `cut` header
/// line, then the URIs.
pub(crate) fn parse_gnome_copied_files(bytes: &[u8]) -> Result<Vec<String>, AdapterError> {
    let text = std::str::from_utf8(bytes).map_err(|_| malformed("text that is not UTF-8"))?;
    let first_line = text.split('\n').next().unwrap_or("");
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let body = if matches!(first_line, "copy" | "cut") {
        text.get(first_line.len()..).unwrap_or("")
    } else {
        text
    };
    parse_uri_list(body.as_bytes())
}

fn uri_of(path: &str) -> String {
    format!("file://{}", percent_encode(path))
}

/// The `text/uri-list` body for `paths`: one CRLF-terminated URI per path.
pub(crate) fn encode_uri_list(paths: &[String]) -> Vec<u8> {
    paths
        .iter()
        .map(|path| format!("{}\r\n", uri_of(path)))
        .collect::<String>()
        .into_bytes()
}

/// The `x-special/gnome-copied-files` body: `copy`, then one URI per line,
/// with no trailing newline.
pub(crate) fn encode_gnome_copied_files(paths: &[String]) -> Vec<u8> {
    let mut lines = vec!["copy".to_owned()];
    lines.extend(paths.iter().map(|path| uri_of(path)));
    lines.join("\n").into_bytes()
}

#[cfg(test)]
#[path = "uri_list_tests.rs"]
mod tests;
