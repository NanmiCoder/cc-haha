use crate::{WindowInfo, system::display_info::DisplayInfo};

pub enum ScreenshotTarget {
    Screen(usize),
    Display { index: usize, expected: DisplayInfo },
    ExactWindow(WindowInfo),
    FullScreen,
}
