use clap::Parser;
use serde::Deserialize;

const DEFAULT_VERTICAL_LINES: f64 = -3.0;

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MouseWheelArgs {
    #[arg(
        long,
        help = "Absolute X coordinate for wheel event; write a negative value with = (--x=-100)"
    )]
    pub x: f64,
    #[arg(
        long,
        help = "Absolute Y coordinate for wheel event; write a negative value with = (--y=-100)"
    )]
    pub y: f64,
    #[arg(
        long,
        allow_negative_numbers = true,
        help = "Vertical wheel lines; positive scrolls up, negative scrolls down (default -3 when --dx is absent, else 0)"
    )]
    #[serde(default)]
    pub dy: Option<f64>,
    #[arg(
        long,
        default_value = "0",
        allow_negative_numbers = true,
        help = "Horizontal wheel lines; positive scrolls right, negative scrolls left"
    )]
    #[serde(default)]
    pub dx: f64,
    #[arg(
        long,
        value_name = "MODIFIER",
        help = "Held modifiers: shift, meta, ctrl, alt (repeatable; cmd is accepted)"
    )]
    #[serde(default)]
    pub modifiers: Vec<String>,
}

impl MouseWheelArgs {
    pub(crate) fn vertical_lines(&self) -> f64 {
        self.dy.unwrap_or(if self.dx == 0.0 {
            DEFAULT_VERTICAL_LINES
        } else {
            0.0
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(dx: f64, dy: Option<f64>) -> MouseWheelArgs {
        MouseWheelArgs {
            x: 0.0,
            y: 0.0,
            dy,
            dx,
            modifiers: Vec::new(),
        }
    }

    #[test]
    fn no_delta_scrolls_down_three_lines() {
        assert_eq!(args(0.0, None).vertical_lines(), -3.0);
    }

    #[test]
    fn a_horizontal_delta_alone_adds_no_vertical_scroll() {
        assert_eq!(args(5.0, None).vertical_lines(), 0.0);
    }

    #[test]
    fn an_explicit_vertical_delta_is_kept_with_or_without_a_horizontal_one() {
        assert_eq!(args(5.0, Some(2.0)).vertical_lines(), 2.0);
        assert_eq!(args(0.0, Some(0.0)).vertical_lines(), 0.0);
    }
}
