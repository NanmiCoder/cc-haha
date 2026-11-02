use std::process::Command;
use std::time::{Duration, Instant};

use crate::input::x11::live_tests::shell_stage_has_focus;

const COVER_NAME: &str = "Cover";
const TOP_LEVEL_INDENT: usize = 5;

struct Row {
    top: usize,
    id: String,
    name: String,
    rect: (i32, i32, i32, i32),
}

fn pair(text: &str, separator: char) -> Option<(i32, i32)> {
    let (first, second) = text.split_once(separator)?;
    Some((first.parse().ok()?, second.parse().ok()?))
}

fn parse_row(body: &str, top: usize) -> Option<Row> {
    let tokens: Vec<&str> = body.split_whitespace().collect();
    let [.., geometry, absolute] = tokens.as_slice() else {
        return None;
    };
    let (size, _) = geometry.split_once('+')?;
    let (width, height) = pair(size, 'x')?;
    let (x, y) = pair(absolute.strip_prefix('+')?, '+')?;
    let name = body
        .find('"')
        .zip(body.find("\": ("))
        .and_then(|(start, end)| body.get(start + 1..end))
        .unwrap_or_default()
        .to_owned();
    Some(Row {
        top,
        id: (*tokens.first()?).to_owned(),
        name,
        rect: (x, y, width, height),
    })
}

/// The windows `xwininfo` lists. It lists the children of the root from the
/// topmost window down, so a smaller `top` stands higher in the stack.
fn rows() -> Result<Vec<Row>, String> {
    let output = Command::new("xwininfo")
        .args(["-root", "-tree"])
        .output()
        .map_err(|error| format!("xwininfo did not run: {error}"))?;
    let mut top = 0;
    let mut rows = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let body = line.trim_start();
        if !body.starts_with("0x") {
            continue;
        }
        if line.len() - body.len() == TOP_LEVEL_INDENT {
            top += 1;
        }
        rows.extend(parse_row(body, top));
    }
    if rows.is_empty() {
        return Err("xwininfo listed no windows".to_owned());
    }
    Ok(rows)
}

fn viewable(id: &str) -> bool {
    Command::new("xwininfo")
        .args(["-id", id])
        .output()
        .is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout).contains("Map State: IsViewable")
        })
}

/// Whether the X server shows a mapped window named `Cover`, read through
/// `xwininfo` and nothing of the product.
pub(in crate::actions) fn cover_viewable() -> Result<bool, String> {
    Ok(rows()?
        .iter()
        .any(|row| row.name == COVER_NAME && viewable(&row.id)))
}

/// Proof from the X server alone that the viewable `Cover` window stands above
/// the window titled with `tag` and holds `point`, a root coordinate.
pub(in crate::actions) fn cover_above(tag: &str, point: (i32, i32)) -> Result<(), String> {
    let rows = rows()?;
    let target = rows
        .iter()
        .find(|row| row.name.contains(tag))
        .ok_or_else(|| format!("no window is titled {tag}"))?;
    let cover = rows
        .iter()
        .rev()
        .find(|row| row.name == COVER_NAME)
        .ok_or_else(|| format!("no window is named {COVER_NAME}"))?;
    let (x, y, width, height) = cover.rect;
    if !(x..x + width).contains(&point.0) || !(y..y + height).contains(&point.1) {
        return Err(format!(
            "{COVER_NAME} {:?} does not hold {point:?}",
            cover.rect
        ));
    }
    if cover.top >= target.top {
        return Err(format!(
            "{COVER_NAME} is not stacked above the fixture window"
        ));
    }
    if !viewable(&cover.id) {
        return Err(format!("{COVER_NAME} {} is not viewable", cover.id));
    }
    Ok(())
}

/// Waits until no shell popup holds the keyboard focus: while one is open the
/// window manager activates no window, and a fixture window never becomes
/// active.
pub(in crate::actions) fn wait_for_free_keyboard_focus(budget: Duration) -> Result<(), String> {
    let started = Instant::now();
    while shell_stage_has_focus() {
        if started.elapsed() >= budget {
            return Err(
                "GNOME Shell's stage still holds the keyboard focus, so an earlier test left a shell popup open and no window can become active"
                    .to_owned(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
