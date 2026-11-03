#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdScreenshotKind {
    Screen = 0,
    FullScreen = 2,
}
