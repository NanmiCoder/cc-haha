use clap::Args;
use serde::Deserialize;

fn default_max_depth() -> u8 {
    10
}

#[derive(Args, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotTreeArgs {
    #[arg(long, default_value = "10", help = "Maximum tree depth (default 10)")]
    #[serde(default = "default_max_depth")]
    pub max_depth: u8,
    #[arg(long, help = "Include element bounds (x, y, width, height)")]
    #[serde(default)]
    pub include_bounds: bool,
    #[arg(long, short = 'i', help = "Include interactive elements only")]
    #[serde(default)]
    pub interactive_only: bool,
    #[arg(
        long,
        help = "Collapse single-child unnamed nodes to reduce tree depth"
    )]
    #[serde(default)]
    pub compact: bool,
    #[arg(
        long,
        help = "Shallow overview with children_count on truncated containers"
    )]
    #[serde(default)]
    pub skeleton: bool,
}
