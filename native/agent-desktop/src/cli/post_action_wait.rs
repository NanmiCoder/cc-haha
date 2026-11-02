use clap::Args;

#[derive(Args, Debug)]
pub(crate) struct PostActionWaitArgs {
    #[arg(
        long,
        short = 'w',
        global = true,
        conflicts_with = "wait_for_gone",
        help = "Poll until an element matching the role:text selector appears, then return the snapshot (snapshot and ref actions only)"
    )]
    pub wait_for: Option<String>,
    #[arg(
        long,
        global = true,
        conflicts_with = "wait_for",
        help = "Poll until no element matches the role:text selector, then return the snapshot (snapshot and ref actions only)"
    )]
    pub wait_for_gone: Option<String>,
    #[arg(
        long,
        global = true,
        help = "Maximum wait time in milliseconds for --wait-for / --wait-for-gone (default: 30000)"
    )]
    pub wait_timeout: Option<u64>,
}
