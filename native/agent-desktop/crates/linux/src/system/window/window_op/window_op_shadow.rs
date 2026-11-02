use agent_desktop_core::AdapterError;
use serde_json::Value;

use crate::system::x11::control::control_send::WindowWrite;

/// The client-side shadow of a window as left, top, right, bottom. A window
/// operation speaks the rectangle `list-windows` reports, the window without
/// its shadow, while the manager places the X11 client, which includes it.
pub(in crate::system) type Shadow = (i32, i32, i32, i32);

fn grown(side: u32, before: i32, after: i32) -> u32 {
    let total = i64::from(side) + i64::from(before) + i64::from(after);
    u32::try_from(total.max(0)).unwrap_or(u32::MAX)
}

/// The write for the client that asks for the visible rectangle `write` names.
pub(in crate::system) fn to_client(write: WindowWrite, shadow: Shadow) -> WindowWrite {
    let (left, top, right, bottom) = shadow;
    match write {
        WindowWrite::MoveResize {
            x,
            y,
            width,
            height,
        } => WindowWrite::MoveResize {
            x: x.map(|x| x.saturating_sub(left)),
            y: y.map(|y| y.saturating_sub(top)),
            width: width.map(|width| grown(width, left, right)),
            height: height.map(|height| grown(height, top, bottom)),
        },
        other => other,
    }
}

fn shift(object: &mut Value, key: &str, by: i64) {
    if let Some(number) = object.get(key).and_then(Value::as_i64) {
        object[key] = Value::from(number + by);
    }
}

/// Rewrites a client rectangle into the visible window's rectangle, the one
/// the caller asked in and `list-windows` reports.
pub(in crate::system) fn visible_of(mut rectangle: Value, shadow: Shadow) -> Value {
    let (left, top, right, bottom) = shadow;
    shift(&mut rectangle, "x", i64::from(left));
    shift(&mut rectangle, "y", i64::from(top));
    shift(&mut rectangle, "width", -i64::from(left) - i64::from(right));
    shift(
        &mut rectangle,
        "height",
        -i64::from(top) - i64::from(bottom),
    );
    rectangle
}

/// Rewrites the client rectangles of an error back into the visible window's.
pub(in crate::system) fn to_visible(mut error: AdapterError, shadow: Shadow) -> AdapterError {
    let Some(details) = error.details.as_mut() else {
        return error;
    };
    for key in ["requested", "observed"] {
        if let Some(rectangle) = details.get_mut(key) {
            *rectangle = visible_of(rectangle.take(), shadow);
        }
    }
    error
}
