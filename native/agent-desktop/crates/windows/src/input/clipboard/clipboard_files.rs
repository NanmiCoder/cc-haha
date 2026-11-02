//! Pure `CF_HDROP` marshalling: `DROPFILES` + double-NUL wide paths ↔ `Vec<String>`.

use agent_desktop_core::AdapterError;
use std::mem::size_of;

use super::clipboard_bytes::{argument_error, payload_error, read_i32, read_u32, read_utf16_units};

const MAX_HDROP_PATHS: usize = 1_024;
const MAX_HDROP_PATH_UTF16: usize = 16_384;
const MAX_HDROP_TOTAL_UTF16: usize = 1_000_000;

#[repr(C, packed(1))]
struct DropFiles {
    p_files: u32,
    pt_x: i32,
    pt_y: i32,
    f_nc: i32,
    f_wide: i32,
}

const DROPFILES_SIZE: usize = size_of::<DropFiles>();

pub(crate) fn decode_hdrop(bytes: &[u8]) -> Result<Vec<String>, AdapterError> {
    if bytes.len() < DROPFILES_SIZE {
        return Err(payload_error("CF_HDROP payload is shorter than DROPFILES"));
    }
    let header = read_dropfiles(bytes)?;
    let list_offset = header.p_files as usize;
    if list_offset < DROPFILES_SIZE || list_offset > bytes.len() {
        return Err(payload_error("CF_HDROP pFiles offset is out of range"));
    }
    if header.f_wide == 0 {
        return Err(payload_error(
            "CF_HDROP ANSI path lists are not supported; expected fWide",
        ));
    }
    decode_wide_paths(&bytes[list_offset..])
}

pub(crate) fn encode_hdrop(paths: &[String]) -> Result<Vec<u8>, AdapterError> {
    if paths.len() > MAX_HDROP_PATHS {
        return Err(argument_error(
            "CF_HDROP path list exceeds the supported entry budget",
        ));
    }
    let mut total_units = 0_usize;
    let mut wide_chunks = Vec::with_capacity(paths.len());
    for path in paths {
        if path.contains('\0') {
            return Err(argument_error(
                "CF_HDROP paths must not contain an embedded NUL",
            ));
        }
        let units = path.encode_utf16().count();
        if units > MAX_HDROP_PATH_UTF16 {
            return Err(argument_error(
                "CF_HDROP path exceeds the supported length budget",
            ));
        }
        total_units = total_units
            .checked_add(units)
            .ok_or_else(|| argument_error("CF_HDROP path list text budget overflowed"))?;
        if total_units > MAX_HDROP_TOTAL_UTF16 {
            return Err(argument_error(
                "CF_HDROP paths exceed the total text budget",
            ));
        }
        wide_chunks.push(path.encode_utf16().collect::<Vec<u16>>());
    }

    let list_bytes = wide_list_bytes(&wide_chunks);
    let mut out = vec![0u8; DROPFILES_SIZE + list_bytes.len()];
    write_dropfiles(
        &mut out[..DROPFILES_SIZE],
        DropFiles {
            p_files: DROPFILES_SIZE as u32,
            pt_x: 0,
            pt_y: 0,
            f_nc: 0,
            f_wide: 1,
        },
    );
    out[DROPFILES_SIZE..].copy_from_slice(&list_bytes);
    Ok(out)
}

fn decode_wide_paths(list: &[u8]) -> Result<Vec<String>, AdapterError> {
    if !list.len().is_multiple_of(2) {
        return Err(payload_error(
            "CF_HDROP wide path list length is not a whole number of UTF-16 units",
        ));
    }
    if list.len() < 4 {
        return Err(payload_error(
            "CF_HDROP wide path list is missing the double-NUL terminator",
        ));
    }
    let units: Vec<u16> = read_utf16_units(list);
    if units.len() < 2 || units[units.len() - 1] != 0 || units[units.len() - 2] != 0 {
        return Err(payload_error(
            "CF_HDROP wide path list is missing the double-NUL terminator",
        ));
    }

    let mut paths = Vec::new();
    let mut total_units = 0_usize;
    let mut start = 0_usize;
    let mut index = 0_usize;
    while index + 1 < units.len() {
        if units[index] != 0 {
            index += 1;
            continue;
        }
        if index == start {
            if index + 1 < units.len() && units[index + 1] == 0 && start == 0 && paths.is_empty() {
                return Ok(Vec::new());
            }
            return Err(payload_error("CF_HDROP path entry is empty"));
        }
        if paths.len() >= MAX_HDROP_PATHS {
            return Err(payload_error(
                "CF_HDROP path list exceeds the supported entry budget",
            ));
        }
        let slice = &units[start..index];
        if slice.len() > MAX_HDROP_PATH_UTF16 {
            return Err(payload_error(
                "CF_HDROP path exceeds the supported length budget",
            ));
        }
        total_units = total_units
            .checked_add(slice.len())
            .ok_or_else(|| payload_error("CF_HDROP path list text budget overflowed"))?;
        if total_units > MAX_HDROP_TOTAL_UTF16 {
            return Err(payload_error("CF_HDROP paths exceed the total text budget"));
        }
        paths.push(String::from_utf16_lossy(slice));
        index += 1;
        start = index;
        if index < units.len() && units[index] == 0 {
            return Ok(paths);
        }
    }
    Err(payload_error(
        "CF_HDROP wide path list is missing the double-NUL terminator",
    ))
}

fn wide_list_bytes(chunks: &[Vec<u16>]) -> Vec<u8> {
    let unit_count = if chunks.is_empty() {
        2
    } else {
        chunks.iter().map(|chunk| chunk.len() + 1).sum::<usize>() + 1
    };
    let mut out = Vec::with_capacity(unit_count * 2);
    for chunk in chunks {
        for unit in chunk {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out.extend_from_slice(&0u16.to_le_bytes());
    if chunks.is_empty() {
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out
}

fn read_dropfiles(bytes: &[u8]) -> Result<DropFiles, AdapterError> {
    let header = bytes
        .get(..DROPFILES_SIZE)
        .ok_or_else(|| payload_error("CF_HDROP payload is shorter than DROPFILES"))?;
    Ok(DropFiles {
        p_files: read_u32(header, 0, "CF_HDROP header field")?,
        pt_x: read_i32(header, 4, "CF_HDROP header field")?,
        pt_y: read_i32(header, 8, "CF_HDROP header field")?,
        f_nc: read_i32(header, 12, "CF_HDROP header field")?,
        f_wide: read_i32(header, 16, "CF_HDROP header field")?,
    })
}

fn write_dropfiles(dst: &mut [u8], header: DropFiles) {
    dst[0..4].copy_from_slice(&header.p_files.to_le_bytes());
    dst[4..8].copy_from_slice(&header.pt_x.to_le_bytes());
    dst[8..12].copy_from_slice(&header.pt_y.to_le_bytes());
    dst[12..16].copy_from_slice(&header.f_nc.to_le_bytes());
    dst[16..20].copy_from_slice(&header.f_wide.to_le_bytes());
}

#[cfg(test)]
#[path = "clipboard_files_tests.rs"]
mod tests;
