use clap::{Parser, ValueEnum};
use serde::Deserialize;

use super::drag_target::DragTargetArgs;

fn default_ref_timeout_ms() -> u64 {
    5000
}

/// Selects which drag endpoint's window scopes the post-action
/// `--wait-for` / `--wait-for-gone` verification. Maps 1:1 to
/// [`agent_desktop_core::commands::drag::WaitForScope`] via [`Self::to_core`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WaitForScopeArg {
    From,
    To,
}

impl WaitForScopeArg {
    pub(crate) fn to_core(self) -> agent_desktop_core::commands::drag::WaitForScope {
        match self {
            Self::From => agent_desktop_core::commands::drag::WaitForScope::From,
            Self::To => agent_desktop_core::commands::drag::WaitForScope::To,
        }
    }
}

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DragCliArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub target: DragTargetArgs,
    #[arg(long, help = "Drag duration in milliseconds")]
    pub duration: Option<u64>,
    #[arg(
        long = "drop-delay",
        value_name = "MS",
        help = "Hold over the destination this many ms before releasing, so the drop target activates; default 500 (150 on Linux)"
    )]
    pub drop_delay: Option<u64>,
    #[arg(
        long = "timeout-ms",
        default_value_t = 5000,
        help = "Drag action budget in milliseconds, including resolution, actionability, pickup, duration and drop delay; allow headroom for completion"
    )]
    #[serde(default = "default_ref_timeout_ms")]
    pub timeout_ms: u64,
    #[arg(
        long = "wait-for-scope",
        value_name = "SCOPE",
        value_enum,
        help = "Window a drag's --wait-for/--wait-for-gone verification polls: 'to' (drop target, default) or 'from' (pickup). Needed when the confirmation appears only in the destination window of a cross-window drag"
    )]
    #[serde(default)]
    pub wait_for_scope: Option<WaitForScopeArg>,
}
