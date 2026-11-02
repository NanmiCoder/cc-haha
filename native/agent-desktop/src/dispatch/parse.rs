use agent_desktop_core::{
    AppError, ClipboardFormat, Direction, Modifier, MouseButton,
    commands::{get, is_check},
    system::launch_options::LaunchOptions,
};
use std::collections::BTreeMap;

pub(crate) fn parse_get_property(s: &str) -> Result<get::GetProperty, AppError> {
    match s {
        "text" => Ok(get::GetProperty::Text),
        "value" => Ok(get::GetProperty::Value),
        "title" => Ok(get::GetProperty::Title),
        "bounds" => Ok(get::GetProperty::Bounds),
        "role" => Ok(get::GetProperty::Role),
        "states" => Ok(get::GetProperty::States),
        _ => Err(AppError::invalid_input(
            "Unknown property. Valid: text, value, title, bounds, role, states",
        )),
    }
}

pub(crate) fn parse_is_property(s: &str) -> Result<is_check::IsProperty, AppError> {
    match s {
        "visible" => Ok(is_check::IsProperty::Visible),
        "enabled" => Ok(is_check::IsProperty::Enabled),
        "checked" => Ok(is_check::IsProperty::Checked),
        "focused" => Ok(is_check::IsProperty::Focused),
        "expanded" => Ok(is_check::IsProperty::Expanded),
        "selected" => Ok(is_check::IsProperty::Selected),
        _ => Err(AppError::invalid_input(
            "Unknown property. Valid: visible, enabled, checked, focused, expanded, selected",
        )),
    }
}

pub(crate) fn parse_direction(s: &str) -> Result<Direction, AppError> {
    match s {
        "up" => Ok(Direction::Up),
        "down" => Ok(Direction::Down),
        "left" => Ok(Direction::Left),
        "right" => Ok(Direction::Right),
        _ => Err(AppError::invalid_input(
            "Unknown direction. Valid: up, down, left, right",
        )),
    }
}

pub(crate) fn parse_mouse_button(s: &str) -> Result<MouseButton, AppError> {
    match s {
        "left" => Ok(MouseButton::Left),
        "right" => Ok(MouseButton::Right),
        "middle" => Ok(MouseButton::Middle),
        _ => Err(AppError::invalid_input(
            "Unknown button. Valid: left, right, middle",
        )),
    }
}

pub(crate) fn parse_xy(s: &str) -> Result<(f64, f64), AppError> {
    let (x_raw, y_raw) = s.split_once(',').ok_or_else(|| {
        AppError::invalid_input("Invalid coordinates. Expected format: x,y (e.g., 500,300)")
    })?;
    if y_raw.contains(',') {
        return Err(AppError::invalid_input(
            "Invalid coordinates. Expected exactly one comma",
        ));
    }
    let x: f64 = x_raw
        .trim()
        .parse()
        .map_err(|_| AppError::invalid_input("Invalid x coordinate"))?;
    let y: f64 = y_raw
        .trim()
        .parse()
        .map_err(|_| AppError::invalid_input("Invalid y coordinate"))?;
    if !x.is_finite() || !y.is_finite() {
        return Err(AppError::invalid_input(
            "Coordinates must be finite numbers",
        ));
    }
    Ok((x, y))
}

pub(crate) fn parse_xy_opt(s: Option<&str>) -> Result<Option<(f64, f64)>, AppError> {
    match s {
        Some(s) => parse_xy(s).map(Some),
        None => Ok(None),
    }
}

pub(crate) fn parse_clipboard_format(s: &str) -> Result<ClipboardFormat, AppError> {
    match s {
        "auto" => Ok(ClipboardFormat::Auto),
        "text" | "plain_text" | "plaintext" => Ok(ClipboardFormat::Text),
        "image" | "png" => Ok(ClipboardFormat::Image),
        "file-urls" | "file_urls" | "fileurls" => Ok(ClipboardFormat::FileUrls),
        _ => Err(AppError::invalid_input(
            "Unknown clipboard format. Valid: auto, text, image, file-urls",
        )),
    }
}

pub(crate) fn parse_modifiers(values: &[String]) -> Result<Vec<Modifier>, AppError> {
    let mut parsed = Vec::with_capacity(values.len());
    for value in values {
        let modifier = parse_modifier(value)?;
        if parsed.contains(&modifier) {
            return Err(AppError::invalid_input(
                "Each mouse modifier may be supplied only once",
            ));
        }
        parsed.push(modifier);
    }
    Ok(parsed)
}

pub(crate) fn parse_modifier(s: &str) -> Result<Modifier, AppError> {
    match s.to_ascii_lowercase().as_str() {
        "shift" => Ok(Modifier::Shift),
        "meta" | "cmd" | "command" | "super" | "win" => Ok(Modifier::Meta),
        "ctrl" | "control" => Ok(Modifier::Ctrl),
        "alt" | "option" => Ok(Modifier::Alt),
        _ => Err(AppError::invalid_input(
            "Unknown modifier. Valid: shift, meta, ctrl, alt (cmd, command, super and win are aliases of meta)",
        )),
    }
}

pub(crate) fn build_launch_options(
    launch: &crate::cli_args::system::LaunchArgs,
) -> Result<LaunchOptions, AppError> {
    let (args, env) = (launch.args.as_slice(), launch.env.as_slice());
    if let Some(index) = args.iter().position(|argument| argument.contains('\0')) {
        return Err(AppError::invalid_input(format!(
            "Invalid --arg entry #{index}: argument contains a NUL byte"
        )));
    }
    let mut env_map = BTreeMap::new();
    for (idx, pair) in env.iter().enumerate() {
        let (key, value) = parse_env_pair(pair, idx)?;
        if env_map.insert(key, value).is_some() {
            return Err(AppError::invalid_input(format!(
                "Duplicate --env key at entry #{idx}"
            )));
        }
    }
    Ok(LaunchOptions {
        args: args.to_vec(),
        env: env_map,
        cwd: launch.cwd.clone(),
        timeout_ms: launch.timeout,
        attach_if_running: !launch.no_attach,
        activate: launch.activate,
        cdp_port: launch.cdp,
    })
}

fn parse_env_pair(pair: &str, idx: usize) -> Result<(String, String), AppError> {
    let (key, value) = pair.split_once('=').ok_or_else(|| {
        AppError::invalid_input(format!("Invalid --env entry #{idx}: expected KEY=VALUE"))
    })?;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        || key.as_bytes()[0].is_ascii_digit()
    {
        return Err(AppError::invalid_input(format!(
            "Invalid --env entry #{idx}: KEY must be a portable environment identifier"
        )));
    }
    if value.contains('\0') {
        return Err(AppError::invalid_input(format!(
            "Invalid --env entry #{idx}: VALUE contains a NUL byte"
        )));
    }
    Ok((key.to_string(), value.to_string()))
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
