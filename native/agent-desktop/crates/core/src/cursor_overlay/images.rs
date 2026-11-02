use super::CursorImage;
use crate::AdapterError;
use serde::{Deserialize, Serialize};

/// Custom cursor artwork: `arrow` is drawn while the cursor travels and rests, `pointer` once
/// it arrives on a pressable control. Either may be absent; a missing arrow falls back to the
/// built-in cursor, a missing pointer keeps the arrow.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorImages {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    arrow: Option<CursorImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pointer: Option<CursorImage>,
}

impl CursorImages {
    pub const fn is_empty(&self) -> bool {
        self.arrow.is_none() && self.pointer.is_none()
    }

    pub fn validated(self) -> Result<Self, AdapterError> {
        Ok(Self {
            arrow: self.arrow.map(CursorImage::validated).transpose()?,
            pointer: self.pointer.map(CursorImage::validated).transpose()?,
        })
    }

    pub fn set_arrow(&mut self, arrow: Option<CursorImage>) {
        self.arrow = arrow;
    }

    pub fn set_pointer(&mut self, pointer: Option<CursorImage>) {
        self.pointer = pointer;
    }

    pub const fn arrow(&self) -> Option<&CursorImage> {
        self.arrow.as_ref()
    }

    pub const fn pointer(&self) -> Option<&CursorImage> {
        self.pointer.as_ref()
    }
}
