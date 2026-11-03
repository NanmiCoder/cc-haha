mod caret_follow;
mod config;
mod control;
mod cursor_hold;
mod hand_path;
mod image;
mod images;
mod instruction;
mod label_pill;
mod layout;
mod motion;
mod motion_profile;
mod path_shape;
mod phase;
mod pose;
mod product_cursor;
mod style;
mod submit;
mod timing;

pub(crate) use caret_follow::follow_caret_after_key;
pub use config::{CursorOverlayConfig, MAX_CURSOR_LABEL_BYTES, MAX_CURSOR_LABEL_WORDS};
pub use control::{CURSOR_OVERLAY_GREETING, CursorOverlayControl};
pub(crate) use cursor_hold::hold_cursor;
pub use image::{
    CursorImage, MAX_CURSOR_IMAGE_BYTES, MAX_CURSOR_IMAGE_PATH_BYTES, MAX_CURSOR_IMAGE_PIXELS,
};
pub use images::CursorImages;
pub use instruction::CursorOverlayInstruction;
pub use label_pill::{
    LABEL_FONT_POINTS, LABEL_PILL_HEIGHT, LABEL_PILL_MAX_WIDTH, LABEL_PILL_PADDING,
    LABEL_SHADOW_BLUR, LABEL_SHADOW_OFFSET, LABEL_SHADOW_OPACITY, LabelPill,
};
pub use layout::{CURSOR_SAME_POINT, place_label};
pub use motion::CursorMotion;
pub use motion_profile::CursorMotionProfile;
pub use phase::CursorPhase;
pub use pose::CursorPose;
pub use product_cursor::{
    PRODUCT_CURSOR_ARROW, PRODUCT_CURSOR_HEIGHT, PRODUCT_CURSOR_OUTLINE, PRODUCT_CURSOR_WIDTH,
};
pub use style::CursorOverlayStyle;
pub(crate) use submit::{
    cancel_drag, confirms_delivery, dispatch_mouse_event_with_cursor, input_was_delivered, submit,
    submit_caret, submit_caret_follow, submit_drag, submit_drag_effect, submit_travel,
    submit_travel_before_lease,
};
pub use timing::{
    CURSOR_ARRIVAL_TIMEOUT_MS, CURSOR_HIGHLIGHT_HOLD_MS, CURSOR_IDLE_REST_MS,
    CURSOR_LABEL_REVEAL_MS, CURSOR_MOTION_BUDGET_MS, CURSOR_REST_FADE_MS,
};

#[cfg(test)]
mod image_tests;
#[cfg(test)]
mod motion_profile_tests;
#[cfg(test)]
mod routing_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "greeting_tests.rs"]
mod greeting_tests;
