pub(crate) fn clap_command_name(args: impl IntoIterator<Item = String>) -> String {
    use clap::CommandFactory;

    let command = crate::cli::Cli::command();
    let global_flags: Vec<_> = command
        .get_arguments()
        .filter(|arg| arg.is_global_set())
        .map(|arg| {
            (
                arg.get_long().map(str::to_owned),
                arg.get_short(),
                matches!(
                    arg.get_action(),
                    clap::ArgAction::Set | clap::ArgAction::Append
                ),
            )
        })
        .collect();
    let subcommands: Vec<_> = command
        .get_subcommands()
        .map(|subcommand| {
            (
                subcommand.get_name().to_owned(),
                subcommand
                    .get_all_aliases()
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    let mut args = args.into_iter().peekable();
    while let Some(token) = args.next() {
        if let Some(long) = token.strip_prefix("--") {
            let flag = long.split('=').next().unwrap_or(long);
            if let Some((_, _, takes_value)) = global_flags
                .iter()
                .find(|(name, _, _)| name.as_deref() == Some(flag))
            {
                if *takes_value && !long.contains('=') {
                    args.next();
                }
                continue;
            }
        } else if token.starts_with('-') && token.len() == 2 {
            let short = token.chars().nth(1);
            if let Some((_, _, takes_value)) = global_flags
                .iter()
                .find(|(_, candidate, _)| *candidate == short)
            {
                if *takes_value {
                    args.next();
                }
                continue;
            }
        }
        if let Some((name, _)) = subcommands
            .iter()
            .find(|(name, aliases)| token == *name || aliases.contains(&token))
        {
            return name.clone();
        }
    }
    "unknown".to_owned()
}

pub(crate) fn bounded_text(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_none() {
        return prefix;
    }
    format!("{prefix}… <truncated; {} bytes total>", text.len())
}

pub(crate) fn token_label(token: &str) -> String {
    if token.len() <= 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        format!("'{token}'")
    } else {
        format!("token of {} bytes", token.len())
    }
}

#[cfg(test)]
#[path = "diagnostic_tests.rs"]
mod tests;

/// Collapses a clap parse error into one line that still names the offending
/// argument.
///
/// Clap puts its headline on the first line and the argument names on the
/// lines below it, then a blank line, then usage and help boilerplate. Taking
/// only the first line yields "the following required arguments were not
/// provided:" with nothing after the colon, which tells a caller nothing about
/// what to fix. This keeps everything up to the blank line and drops the
/// boilerplate a machine consumer cannot act on.
pub(crate) fn clap_error_summary(message: &str) -> String {
    let summary = message
        .lines()
        .take_while(|line| !line.trim().is_empty())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if summary.is_empty() {
        return "parse error".to_owned();
    }
    summary
}

#[cfg(test)]
#[path = "diagnostic_clap_tests.rs"]
mod clap_tests;
