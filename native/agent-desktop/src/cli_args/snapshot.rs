use clap::Parser;
use serde::Deserialize;

use super::{Surface, WindowScope, snapshot_tree::SnapshotTreeArgs};

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[command(flatten)]
    #[serde(flatten)]
    pub tree: SnapshotTreeArgs,
    #[arg(
        long,
        value_enum,
        default_value_t = Surface::Window,
        help = "Surface to snapshot"
    )]
    #[serde(default)]
    pub surface: Surface,
    #[arg(long, help = "Start traversal from this ref instead of window root")]
    pub root: Option<String>,
    #[arg(
        long,
        value_name = "MS",
        help = "Observation deadline in milliseconds (default 3000; raise for slow Chromium settles)"
    )]
    pub timeout_ms: Option<u64>,
    #[arg(
        long,
        help = "Assume Chromium renderer accessibility is forced (skips activation guidance)"
    )]
    #[serde(default)]
    pub force_electron_a11y: bool,
}
