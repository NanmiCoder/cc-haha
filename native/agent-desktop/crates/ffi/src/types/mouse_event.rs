use crate::types::point::AdPoint;

/// Mouse event dispatched by `ad_mouse_event`.
///
/// `kind` and `button` are stored as `int32_t` for the same reason
/// `AdAction.kind` is — foreign callers cannot place invalid
/// discriminants into Rust enum slots. Valid values are the
/// discriminants of `AdMouseEventKind` and `AdMouseButton`.
#[repr(C)]
pub struct AdMouseEvent {
    pub kind: i32,
    pub point: AdPoint,
    pub button: i32,
    pub click_count: u32,
}
