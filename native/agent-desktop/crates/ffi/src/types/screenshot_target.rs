/// Screenshot target for `ad_screenshot`.
///
/// `kind` is stored as `int32_t` to keep the enum-discriminant check
/// at the boundary. Valid values are the discriminants of
/// `AdScreenshotKind`. `screen_index` is only consulted when kind is
/// `SCREEN`. Window capture goes through `ad_screenshot_window_exact`.
#[repr(C)]
pub struct AdScreenshotTarget {
    pub kind: i32,
    pub screen_index: u64,
}
