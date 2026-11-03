use clap::{Args, Subcommand};
use std::path::PathBuf;

#[derive(Args, Debug)]
pub(crate) struct TraceArgs {
    #[command(subcommand)]
    pub action: TraceAction,
}

#[derive(Subcommand, Debug)]
pub(crate) enum TraceAction {
    #[command(about = "Merge session trace segments into a bounded JSON timeline")]
    Show(TraceShowArgs),
    #[command(about = "Export a self-contained HTML trace viewer")]
    Export(TraceExportArgs),
}

#[derive(Args, Debug)]
pub(crate) struct TraceShowArgs {
    #[arg(
        long,
        default_value_t = agent_desktop_core::commands::trace::TRACE_SHOW_DEFAULT_LIMIT,
        help = "Return the last N merged events (0 for all; default 500)"
    )]
    pub limit: usize,
    #[arg(long, help = "Filter events by name prefix before applying --limit")]
    pub event: Option<String>,
}

#[derive(Args, Debug)]
pub(crate) struct TraceExportArgs {
    #[arg(long, help = "Output HTML path (default trace-<session>.html)")]
    pub out: Option<PathBuf>,
    #[arg(
        long,
        default_value_t = agent_desktop_core::trace::trace_read::TRACE_EXPORT_DEFAULT_LIMIT,
        help = "Embed the last N merged events (0 for all; default 5000)"
    )]
    pub limit: usize,
}
