use agent_desktop_core::{
    AdapterError, ClipboardContent, ErrorCode, MAX_PNG_INPUT_BYTES, parse_png_dimensions,
};

use super::formats::{self, GNOME_FILES, PNG, URI_LIST};
use super::target::Target;
use super::uri_list;

pub(crate) const GENERATION: u8 = 1;

const NAME_LENGTH_BYTES: usize = 4;
const DATA_LENGTH_BYTES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Payload {
    pub(crate) targets: Vec<Target>,
}

fn invalid(message: impl Into<String>) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

fn over_cap() -> AdapterError {
    invalid(format!(
        "The clipboard payload is over the {} MiB cap",
        MAX_PNG_INPUT_BYTES / (1024 * 1024)
    ))
}

/// Every target one owner serves for `content`. An image keeps its PNG bytes
/// as they are; paths are offered as both file-manager list formats.
pub(crate) fn payload_of(content: &ClipboardContent) -> Result<Payload, AdapterError> {
    let targets = match content {
        ClipboardContent::Text(text) => formats::encode_text_targets(text),
        ClipboardContent::Image(image) => {
            let dimensions = parse_png_dimensions(&image.data);
            if dimensions != Some((image.width, image.height)) {
                return Err(invalid("The image's size does not match its PNG data"));
            }
            vec![Target {
                name: PNG.to_owned(),
                bytes: image.data.clone(),
            }]
        }
        ClipboardContent::FileUrls(paths) => {
            if paths.is_empty() || paths.iter().any(|path| !path.starts_with('/')) {
                return Err(invalid(
                    "Clipboard file paths must be absolute and not empty",
                ));
            }
            vec![
                Target {
                    name: URI_LIST.to_owned(),
                    bytes: uri_list::encode_uri_list(paths),
                },
                Target {
                    name: GNOME_FILES.to_owned(),
                    bytes: uri_list::encode_gnome_copied_files(paths),
                },
            ]
        }
    };
    let largest = targets.iter().map(|target| target.bytes.len()).max();
    if largest.is_some_and(|size| size > MAX_PNG_INPUT_BYTES) {
        return Err(over_cap());
    }
    Ok(Payload { targets })
}

/// The bytes the setter hands the owner: the generation, the target count,
/// then per target its name length, name, data length and data.
pub(crate) fn frame(payload: &Payload) -> Vec<u8> {
    let mut out = vec![GENERATION];
    out.extend_from_slice(
        &u32::try_from(payload.targets.len())
            .unwrap_or(u32::MAX)
            .to_le_bytes(),
    );
    for target in &payload.targets {
        let name = target.name.as_bytes();
        out.extend_from_slice(&u32::try_from(name.len()).unwrap_or(u32::MAX).to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&(target.bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(&target.bytes);
    }
    out
}

fn damaged(why: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The clipboard payload is damaged: {why}"),
    )
}

struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], AdapterError> {
        if len > self.rest.len() {
            return Err(damaged("a length overruns the buffer"));
        }
        let (head, tail) = self.rest.split_at(len);
        self.rest = tail;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], AdapterError> {
        self.take(N)?
            .try_into()
            .map_err(|_| damaged("a short field"))
    }
}

pub(crate) fn unframe(bytes: &[u8]) -> Result<Payload, AdapterError> {
    let mut cursor = Cursor { rest: bytes };
    let generation = cursor.take(1)?[0];
    if generation != GENERATION {
        return Err(damaged(&format!("unknown generation {generation}")));
    }
    let count = u32::from_le_bytes(cursor.array()?) as usize;
    if count == 0 {
        return Err(damaged("no targets"));
    }
    if count > cursor.rest.len() / (NAME_LENGTH_BYTES + DATA_LENGTH_BYTES) {
        return Err(damaged("more targets than the buffer can hold"));
    }
    let mut targets = Vec::with_capacity(count);
    for _ in 0..count {
        let name_len = u32::from_le_bytes(cursor.array()?) as usize;
        let name = String::from_utf8(cursor.take(name_len)?.to_vec())
            .map_err(|_| damaged("a target name that is not UTF-8"))?;
        let data_len = usize::try_from(u64::from_le_bytes(cursor.array()?))
            .map_err(|_| damaged("a length overruns"))?;
        let data = cursor.take(data_len)?.to_vec();
        targets.push(Target { name, bytes: data });
    }
    if !cursor.rest.is_empty() {
        return Err(damaged("bytes after the last target"));
    }
    Ok(Payload { targets })
}

#[cfg(test)]
#[path = "payload_tests.rs"]
mod tests;
