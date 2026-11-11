use clap::Parser;
use serde::Deserialize;

fn default_scroll_amount() -> u32 {
    3
}

fn default_mouse_button() -> String {
    "left".to_string()
}

fn default_mouse_click_count() -> u32 {
    1
}

fn default_scroll_direction() -> String {
    "down".to_string()
}

fn default_ref_timeout_ms() -> u64 {
    5000
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TypeArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(value_name = "TEXT", allow_hyphen_values = true, help = "Text to type")]
    pub text: String,
    #[arg(
        long = "timeout-ms",
        help = "Maximum wait in milliseconds, covering ref resolution, actionability and delivery of the text; default 5000 plus 30 per character of TEXT; 0 disables the wait"
    )]
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[arg(
        long = "interval-ms",
        value_parser = clap::value_parser!(u64).range(1..=2000),
        help = "Type one keystroke every N ms (1-2000) instead of inserting TEXT at once; --timeout-ms then applies to each keystroke, and 0 makes each keystroke try once"
    )]
    #[serde(default)]
    pub interval_ms: Option<u64>,
}

impl TypeArgs {
    pub(crate) fn effective_timeout_ms(&self) -> u64 {
        if let Some(interval_ms) = self.interval_ms {
            return agent_desktop_core::commands::type_text::interval_budget_ms(
                &self.text,
                interval_ms,
                self.timeout_ms,
            );
        }
        self.timeout_ms.unwrap_or_else(|| {
            agent_desktop_core::commands::type_text::default_timeout_ms(&self.text)
        })
    }
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SetValueArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(
        value_name = "VALUE",
        allow_hyphen_values = true,
        help = "Value to set"
    )]
    pub value: String,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(value_name = "VALUE", help = "Option to select")]
    pub value: String,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScrollArgs {
    #[arg(
        value_name = "REF",
        help = "Qualified ref from snapshot (@<snapshot_id>:eN)"
    )]
    pub ref_id: String,
    #[arg(
        long,
        default_value = "down",
        help = "Direction: up, down, left, right"
    )]
    #[serde(default = "default_scroll_direction")]
    pub direction: String,
    #[arg(long, default_value = "3", help = "Number of scroll units")]
    #[serde(default = "default_scroll_amount")]
    pub amount: u32,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PressArgs {
    #[arg(
        value_name = "COMBO",
        help = "Key combo: return, escape, cmd+c, shift+tab ..."
    )]
    pub combo: String,
    #[arg(
        long,
        help = "Target application name; keys go to its process without focusing it (--headed focuses its window first)"
    )]
    pub app: Option<String>,
    #[arg(
        long = "window-id",
        help = "Target the application instance that owns this window (from list-windows); \
                use it when several instances share one name"
    )]
    #[serde(default)]
    pub window_id: Option<String>,
    #[arg(
        long,
        help = "Send the combo even if the adapter flags it as a dangerous shortcut"
    )]
    #[serde(default)]
    pub force: bool,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KeyComboArgs {
    #[arg(
        value_name = "COMBO",
        help = "Key or modifier to hold/release: shift, meta, ctrl ... (cmd is accepted); the command is rejected in stateless mode, use press instead"
    )]
    pub combo: String,
    #[arg(
        long,
        help = "Send the combo even if the adapter flags it as a dangerous shortcut"
    )]
    #[serde(default)]
    pub force: bool,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HoverArgs {
    #[arg(
        value_name = "REF",
        help = "Element ref to hover over; requires --headed"
    )]
    pub ref_id: Option<String>,
    #[arg(
        long,
        help = "Absolute coordinates as x,y; requires --headed; write a negative value with = (--xy=-100,50)"
    )]
    pub xy: Option<String>,
    #[arg(
        long,
        help = "Reserved for compatibility; positive values are rejected in stateless mode (run hover, then `wait <ms>` instead)"
    )]
    pub duration: Option<u64>,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MouseMoveArgs {
    #[arg(
        long,
        help = "Absolute coordinates as x,y; requires --headed; write a negative value with = (--xy=-100,50)"
    )]
    pub xy: String,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MouseClickArgs {
    #[arg(
        long,
        help = "Absolute coordinates as x,y; requires --headed; write a negative value with = (--xy=-100,50)"
    )]
    pub xy: String,
    #[arg(
        long,
        default_value = "left",
        help = "Mouse button: left, right, middle"
    )]
    #[serde(default = "default_mouse_button")]
    pub button: String,
    #[arg(long, default_value = "1", help = "Number of clicks")]
    #[serde(default = "default_mouse_click_count")]
    pub count: u32,
    #[arg(
        long,
        value_name = "MODIFIER",
        help = "Held modifiers: shift, meta, ctrl, alt (repeatable; cmd is accepted)"
    )]
    #[serde(default)]
    pub modifiers: Vec<String>,
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MousePointArgs {
    #[arg(
        long,
        help = "Absolute coordinates as x,y; requires --headed; write a negative value with = (--xy=-100,50)"
    )]
    pub xy: String,
    #[arg(
        long,
        default_value = "left",
        help = "Mouse button: left, right, middle"
    )]
    #[serde(default = "default_mouse_button")]
    pub button: String,
    #[arg(
        long,
        value_name = "MODIFIER",
        help = "Held modifiers: shift, meta, ctrl, alt (repeatable; cmd is accepted)"
    )]
    #[serde(default)]
    pub modifiers: Vec<String>,
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
