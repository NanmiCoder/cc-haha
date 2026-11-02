use clap::{Args, Subcommand};

#[derive(Args, Debug)]
pub(crate) struct SessionArgs {
    #[command(subcommand)]
    pub action: SessionAction,
}

#[derive(Subcommand, Debug)]
pub(crate) enum SessionAction {
    #[command(about = "Create a session directory and manifest")]
    Start(SessionStartArgs),
    #[command(about = "Seal a session manifest")]
    End(SessionEndArgs),
    #[command(about = "List session manifests")]
    List,
    #[command(about = "Remove ended or provably-stale sessions")]
    Gc(SessionGcArgs),
}

#[derive(Args, Debug)]
pub(crate) struct SessionStartArgs {
    #[arg(long, help = "Optional human-readable session label")]
    pub name: Option<String>,
    #[arg(long, help = "Create the session without automatic tracing")]
    pub no_trace: bool,
    #[arg(
        long,
        help = "Capture pre/post-action screenshots and refmap copies (requires tracing; sensitive)"
    )]
    pub screenshots: bool,
    #[arg(long, help = "Show the visual cursor overlay with its default style")]
    pub cursor: bool,
    #[arg(
        long,
        requires = "cursor",
        help = "Give each harness subagent its own cursor; requires --agent-id on desktop actions"
    )]
    pub multi_agent: bool,
}

#[derive(Args, Debug)]
pub(crate) struct SessionEndArgs {
    #[arg(help = "Session id to end; defaults to global --session or AGENT_DESKTOP_SESSION")]
    pub id: Option<String>,
}

#[derive(Args, Debug)]
pub(crate) struct SessionGcArgs {
    #[arg(
        long,
        help = "Only remove sessions whose ended_at/created_at age exceeds this many seconds"
    )]
    pub older_than: Option<u64>,
    #[arg(
        long,
        help = "Only consider sessions that already have ended_at set, and remove them even when their trace was written in the last few minutes"
    )]
    pub ended: bool,
}
