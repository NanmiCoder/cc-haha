use clap::Args;

#[derive(Args, Debug)]
pub(crate) struct CursorOverlayEnableArgs {
    #[arg(
        long,
        help = "Require agent IDs for desktop UI actions; use without --agent-id to configure the session"
    )]
    pub multi_agent: bool,
    #[arg(
        long,
        help = "Show caller-authored intent text beside the cursor overlay"
    )]
    pub label: Option<String>,
    #[arg(
        long,
        value_parser = parse_word_limit,
        help = "Limit the cursor overlay label to 1-12 words (default 6)"
    )]
    pub max_words: Option<usize>,
    #[command(flatten)]
    pub style: super::cursor_overlay_style::CursorOverlayStyleArgs,
    #[command(flatten)]
    pub motion: super::cursor_overlay_motion::CursorOverlayMotionArgs,
}

impl CursorOverlayEnableArgs {
    pub(crate) fn to_core(
        &self,
    ) -> Result<agent_desktop_core::CursorOverlayConfig, agent_desktop_core::AppError> {
        agent_desktop_core::CursorOverlayConfig::enabled(
            self.label.clone(),
            self.max_words.unwrap_or(6),
        )
        .map_err(agent_desktop_core::AppError::from)
        .and_then(|config| Ok(config.with_style(self.style.to_core()?)?))
        .and_then(|config| Ok(config.with_motion(self.motion.to_core())?))
    }
}

fn parse_word_limit(value: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| "word limit must be an integer from 1 to 12".to_string())?;
    if (1..=12).contains(&parsed) {
        Ok(parsed)
    } else {
        Err("word limit must be from 1 to 12".to_string())
    }
}
