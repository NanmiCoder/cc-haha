use std::path::PathBuf;

use agent_desktop_core::AppError;
use clap::Args;

use crate::cli::Commands;

#[derive(Args, Debug, Default)]
pub(crate) struct DebugOptions {
    #[arg(
        long,
        short = 'v',
        global = true,
        help = "Enable debug logging to stderr"
    )]
    pub verbose: bool,
    #[arg(
        long,
        global = true,
        requires = "screenshot",
        help = "Visual debug for snapshot/click; requires --screenshot PATH.html"
    )]
    pub debug: bool,
    #[arg(
        long,
        global = true,
        requires = "debug",
        value_name = "PATH.html",
        help = "Write a sensitive, local HTML screenshot visualization (new file only)"
    )]
    pub screenshot: Option<PathBuf>,
}

impl DebugOptions {
    pub(crate) fn validate(&self, command: &Commands) -> Result<(), AppError> {
        if !self.debug {
            return Ok(());
        }
        if !matches!(command, Commands::Snapshot(_) | Commands::Click(_)) {
            return Err(AppError::invalid_input(
                "--debug supports snapshot and click only",
            ));
        }
        if let Commands::Snapshot(args) = command {
            if !matches!(args.surface, crate::cli_args::Surface::Window) {
                return Err(AppError::invalid_input(
                    "Visual debug currently supports the window surface only",
                ));
            }
        }
        if self
            .screenshot
            .as_ref()
            .and_then(|path| path.extension())
            .is_none_or(|ext| ext != "html")
        {
            return Err(AppError::invalid_input(
                "--screenshot requires a new .html output path",
            ));
        }
        Ok(())
    }
}
