use agent_desktop_core::{
    AdapterError, CURSOR_HIGHLIGHT_HOLD_MS, CursorImage, CursorOverlayInstruction,
    CursorOverlayStyle, CursorPhase, CursorPose, ErrorCode, LabelPill, Point, Rect, place_label,
};
use std::ffi::{CString, c_char};

const REDUCE_MOTION: u8 = 1 << 2;
const HIGHLIGHT: u8 = 1 << 3;
const POINT_ON_ARRIVAL: u8 = 1 << 4;
const ARROW_ON_DEPARTURE: u8 = 1 << 5;
const ARROW_AFTER_EFFECT: u8 = 1 << 6;
const ARROW_SLOT: u8 = 0;
const POINTER_SLOT: u8 = 1;

#[repr(C)]
struct NativeCursorStyle {
    fill: [f64; 3],
    rim: [f64; 3],
    accent: [f64; 3],
    size: f64,
}

#[repr(C)]
struct NativeCursorFrame {
    x: f64,
    y: f64,
    ripple: f64,
}

#[repr(C)]
struct NativeRenderConfig {
    frame_seconds: f64,
    label: *const c_char,
    bubble: [f64; 4],
    target: [f64; 4],
    highlight_seconds: f64,
    flags: u8,
}

unsafe extern "C" {
    fn agent_desktop_cursor_overlay_initial_point(output: *mut f64) -> bool;
    fn agent_desktop_cursor_overlay_screen(x: f64, y: f64, output: *mut f64) -> bool;
    fn agent_desktop_cursor_overlay_run(
        frames: *const NativeCursorFrame,
        frame_count: usize,
        config: *const NativeRenderConfig,
    ) -> bool;
    fn agent_desktop_cursor_overlay_drag_begin(x: f64, y: f64, trail: bool);
    fn agent_desktop_cursor_overlay_drag_end(x: f64, y: f64, completed: bool);
    fn agent_desktop_cursor_overlay_drag_active() -> bool;
    fn agent_desktop_cursor_overlay_style(style: *const NativeCursorStyle);
    fn agent_desktop_cursor_overlay_image(
        slot: u8,
        path: *const c_char,
        hotspot_x: f64,
        hotspot_y: f64,
    ) -> bool;
    fn agent_desktop_cursor_overlay_idle();
    fn agent_desktop_cursor_overlay_label_width(label: *const c_char) -> f64;
    fn agent_desktop_cursor_overlay_caret(x: f64, y: f64, width: f64, height: f64);
    fn agent_desktop_cursor_overlay_caret_clear();
    fn agent_desktop_cursor_overlay_caret_follow(
        present: bool,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    );
    fn agent_desktop_cursor_overlay_hide();
    fn agent_desktop_cursor_overlay_rest();
    fn agent_desktop_cursor_overlay_show();
    fn agent_desktop_cursor_overlay_stop();
}

pub(super) fn is_caret(instruction: &CursorOverlayInstruction) -> bool {
    matches!(
        instruction.phase(),
        CursorPhase::Caret | CursorPhase::CaretFollow
    )
}

/// Draws the caret at the instruction's target. `CaretFollow` only moves a
/// caret already showing, and hides it when there is no target.
pub(super) fn caret(instruction: &CursorOverlayInstruction) {
    let follow = instruction.phase() == CursorPhase::CaretFollow;
    match instruction.target() {
        Some(at) if follow => unsafe {
            agent_desktop_cursor_overlay_caret_follow(true, at.x, at.y, at.width, at.height)
        },
        Some(at) => unsafe { agent_desktop_cursor_overlay_caret(at.x, at.y, at.width, at.height) },
        None if follow => unsafe {
            agent_desktop_cursor_overlay_caret_follow(false, 0.0, 0.0, 0.0, 0.0)
        },
        None => {}
    }
}

/// Draws a caret instruction and reports that it was one. Any other
/// instruction clears the caret when it sets the cursor off from `at` for
/// somewhere else; see `CursorOverlayInstruction::departs_from`.
pub(super) fn apply_caret(instruction: &CursorOverlayInstruction, at: Option<&Point>) -> bool {
    if is_caret(instruction) {
        caret(instruction);
        return true;
    }
    if instruction.departs_from(at) {
        unsafe { agent_desktop_cursor_overlay_caret_clear() }
    }
    false
}

pub(super) fn begin_drag(from: &Point, trail: bool) {
    unsafe { agent_desktop_cursor_overlay_drag_begin(from.x, from.y, trail) }
}

pub(super) fn end_drag(to: &Point, completed: bool) {
    unsafe { agent_desktop_cursor_overlay_drag_end(to.x, to.y, completed) }
}

pub(super) fn drag_active() -> bool {
    unsafe { agent_desktop_cursor_overlay_drag_active() }
}

pub(super) fn initial_point() -> Result<Point, AdapterError> {
    let mut output = [0.0; 2];
    if !unsafe { agent_desktop_cursor_overlay_initial_point(output.as_mut_ptr()) } {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "macOS cursor overlay could not select an initial position",
        ));
    }
    Ok(Point {
        x: output[0],
        y: output[1],
    })
}

pub(super) fn screen_at(point: &Point) -> Result<(Rect, u32, bool), AdapterError> {
    let mut output = [0.0; 6];
    if !unsafe { agent_desktop_cursor_overlay_screen(point.x, point.y, output.as_mut_ptr()) } {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "No macOS display contains the cursor overlay destination",
        ));
    }
    Ok((
        Rect {
            x: output[0],
            y: output[1],
            width: output[2],
            height: output[3],
        },
        (output[4] as u32).clamp(60, 120),
        output[5] != 0.0,
    ))
}

pub(super) fn run(
    poses: &[CursorPose],
    fps: u32,
    instruction: &CursorOverlayInstruction,
    reduce_motion: bool,
    screen: &Rect,
) -> Result<(), AdapterError> {
    let frames = poses
        .iter()
        .map(|pose| NativeCursorFrame {
            x: pose.point.x,
            y: pose.point.y,
            ripple: pose.ripple,
        })
        .collect::<Vec<_>>();
    let label = instruction
        .label()
        .map(|value| CString::new(value.replace('\0', " ")))
        .transpose()
        .map_err(|_| AdapterError::internal("Cursor overlay label encoding failed"))?;
    let anchor = poses
        .last()
        .map_or(instruction.destination(), |pose| &pose.point);
    let bubble = label
        .as_ref()
        .zip(instruction.label())
        .and_then(|(encoded, text)| {
            let width = unsafe { agent_desktop_cursor_overlay_label_width(encoded.as_ptr()) };
            LabelPill::for_label(text, width, 1.0)
        })
        .map_or([0.0; 4], |pill| {
            let placed = place_label(anchor, pill.size(), screen);
            [placed.x, placed.y, placed.width, placed.height]
        });
    let mut flags = 0;
    if reduce_motion {
        flags |= REDUCE_MOTION;
    }
    let target = instruction
        .target()
        .map(|rect| [rect.x, rect.y, rect.width, rect.height]);
    if target.is_some() {
        flags |= HIGHLIGHT;
    }
    flags |= pointer_flags(instruction);
    let config = NativeRenderConfig {
        frame_seconds: 1.0 / f64::from(fps),
        label: label
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
        bubble,
        target: target.unwrap_or_default(),
        highlight_seconds: CURSOR_HIGHLIGHT_HOLD_MS as f64 / 1_000.0,
        flags,
    };
    if unsafe { agent_desktop_cursor_overlay_run(frames.as_ptr(), frames.len(), &config) } {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "macOS cursor overlay renderer failed",
        ))
    }
}

pub(super) fn apply_style(style: &CursorOverlayStyle, image_changed: bool) {
    let native = NativeCursorStyle {
        fill: style.fill_rgb(),
        rim: style.rim_rgb(),
        accent: style.accent_rgb(),
        size: style.size(),
    };
    unsafe { agent_desktop_cursor_overlay_style(&native) }
    if image_changed {
        apply_image(ARROW_SLOT, style.image());
        apply_image(POINTER_SLOT, style.pointer_image());
    }
}

fn pointer_flags(instruction: &CursorOverlayInstruction) -> u8 {
    match instruction.phase() {
        CursorPhase::Effect => ARROW_AFTER_EFFECT,
        CursorPhase::Caret | CursorPhase::CaretFollow => 0,
        CursorPhase::Drag => ARROW_ON_DEPARTURE,
        CursorPhase::Travel if instruction.is_pointer() => ARROW_ON_DEPARTURE | POINT_ON_ARRIVAL,
        CursorPhase::Travel => ARROW_ON_DEPARTURE,
    }
}

fn apply_image(slot: u8, image: Option<&CursorImage>) {
    let path = image.and_then(|image| CString::new(image.path()).ok());
    let hotspot = image.map_or((0.0, 0.0), |image| (image.hotspot().x, image.hotspot().y));
    let pointer = path.as_ref().map_or(std::ptr::null(), |path| path.as_ptr());
    let _ = unsafe { agent_desktop_cursor_overlay_image(slot, pointer, hotspot.0, hotspot.1) };
}

pub(super) fn idle() {
    unsafe { agent_desktop_cursor_overlay_idle() }
}

pub(super) fn stop() {
    unsafe { agent_desktop_cursor_overlay_stop() }
}

pub(super) fn rest() {
    unsafe { agent_desktop_cursor_overlay_rest() }
}

pub(super) fn hide() {
    unsafe { agent_desktop_cursor_overlay_hide() }
}

pub(super) fn show() {
    unsafe { agent_desktop_cursor_overlay_show() }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
