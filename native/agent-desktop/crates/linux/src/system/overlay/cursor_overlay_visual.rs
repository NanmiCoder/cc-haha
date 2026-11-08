use std::io::IoSlice;

use agent_desktop_core::AdapterError;
use x11rb::connection::RequestConnection;
use x11rb::rust_connection::RustConnection;

use super::error;

fn word(data: &[u8], offset: usize) -> Result<u32, AdapterError> {
    data.get(offset..offset + 4)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_ne_bytes)
        .ok_or_else(|| error("Truncated RENDER picture formats"))
}

fn short(data: &[u8], offset: usize) -> Result<u16, AdapterError> {
    data.get(offset..offset + 2)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u16::from_ne_bytes)
        .ok_or_else(|| error("Truncated RENDER picture formats"))
}

pub(super) fn argb_visual(connection: &RustConnection, screen: usize) -> Result<u32, AdapterError> {
    let extension = connection
        .extension_information("RENDER")
        .map_err(error)?
        .ok_or_else(|| {
            AdapterError::not_supported("X11 cursor overlay needs RENDER visual information")
        })?;
    let length = 1u16.to_ne_bytes();
    let request = [extension.major_opcode, 1, length[0], length[1]];
    let reply = connection
        .send_request_with_reply::<u8>(&[IoSlice::new(&request)], Vec::new())
        .map_err(error)?
        .raw_reply()
        .map_err(error)?;
    visual_in(&reply, screen)
}

fn visual_in(reply: &[u8], screen: usize) -> Result<u32, AdapterError> {
    let formats = word(reply, 8)? as usize;
    if formats > reply.len().saturating_sub(32) / 28 {
        return Err(error("Truncated RENDER picture formats"));
    }
    let mut argb = Vec::new();
    let mut offset = 32;
    for _ in 0..formats {
        if reply.get(offset + 4..offset + 6) == Some(&[1, 32])
            && [16, 255, 8, 255, 0, 255, 24, 255]
                .into_iter()
                .enumerate()
                .all(|(index, expected)| {
                    short(reply, offset + 8 + index * 2).ok() == Some(expected)
                })
        {
            argb.push(word(reply, offset)?);
        }
        offset += 28;
    }
    for screen_index in 0..word(reply, 12)? as usize {
        let depths = word(reply, offset)?;
        offset += 8;
        for _ in 0..depths {
            let visuals = short(reply, offset + 2)?;
            offset += 8;
            for _ in 0..visuals {
                let visual = word(reply, offset)?;
                let format = word(reply, offset + 4)?;
                offset += 8;
                if screen_index == screen && argb.contains(&format) {
                    return Ok(visual);
                }
            }
        }
    }
    Err(AdapterError::not_supported(
        "X11 cursor overlay needs an ARGB visual",
    ))
}

#[cfg(test)]
#[path = "cursor_overlay_visual_tests.rs"]
mod tests;
