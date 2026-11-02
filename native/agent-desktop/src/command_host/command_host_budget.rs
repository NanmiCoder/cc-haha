use agent_desktop_core::{AdapterError, AppError, Deadline};
use std::time::Duration;

pub(super) fn expires_at(cli: &crate::Cli, command: &crate::Commands) -> Result<u64, AppError> {
    let budget = budget_ms(cli, command)?;
    Deadline::detached_after(budget)?;
    now()?
        .checked_add(
            budget
                .checked_mul(1_000_000)
                .ok_or_else(|| AppError::invalid_input("Command host budget is too large"))?,
        )
        .ok_or_else(|| AppError::invalid_input("Command host deadline is too large"))
}

pub(super) fn remaining(expires_ns: u64) -> Result<Duration, AppError> {
    remaining_at(expires_ns, now()?)
}

fn remaining_at(expires_ns: u64, now_ns: u64) -> Result<Duration, AppError> {
    match expires_ns
        .checked_sub(now_ns)
        .filter(|remaining| *remaining > 0)
    {
        Some(remaining) => Ok(Duration::from_nanos(remaining)),
        None => Err(AdapterError::timeout("Command host request expired before dispatch").into()),
    }
}

fn now() -> Result<u64, AppError> {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    u64::try_from(time.tv_sec)
        .ok()
        .and_then(|seconds| seconds.checked_mul(1_000_000_000))
        .and_then(|seconds| seconds.checked_add(time.tv_nsec as u64))
        .ok_or_else(|| AppError::Internal("Monotonic clock is outside its supported range".into()))
}

fn budget_ms(cli: &crate::Cli, command: &crate::Commands) -> Result<u64, AppError> {
    use crate::Commands;
    let primary = match command {
        Commands::Click(a)
        | Commands::DoubleClick(a)
        | Commands::TripleClick(a)
        | Commands::RightClick(a)
        | Commands::Clear(a)
        | Commands::Focus(a)
        | Commands::Toggle(a)
        | Commands::Check(a)
        | Commands::Uncheck(a)
        | Commands::Expand(a)
        | Commands::Collapse(a)
        | Commands::ScrollTo(a) => a.timeout_ms,
        Commands::Type(a) => a.effective_timeout_ms(),
        Commands::SetValue(a) => a.timeout_ms,
        Commands::Select(a) => a.timeout_ms,
        Commands::Scroll(a) => a.timeout_ms,
        Commands::Hover(a) => a.timeout_ms,
        Commands::Drag(a) => a.timeout_ms,
        Commands::Wait(a) => match a.mode.ms {
            Some(ms) => ms
                .checked_add(5000)
                .ok_or_else(|| AppError::invalid_input("Wait is too long"))?,
            None => a.timeout,
        },
        Commands::Snapshot(a) => a
            .timeout_ms
            .unwrap_or(agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS),
        Commands::Find(a) => a
            .timeout_ms
            .unwrap_or(agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS),
        Commands::ListApps(a) => a
            .timeout_ms
            .unwrap_or(agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS),
        Commands::ListWindows(a) => a
            .timeout_ms
            .unwrap_or(agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS),
        Commands::Launch(a) => a.timeout,
        Commands::Batch(a) => a.timeout_ms,
        _ => agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS,
    };
    let primary = if primary == 0 {
        agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS
    } else {
        primary
    };
    let post_wait = crate::build_wait_selector(cli)?.map_or(0, |wait| wait.timeout_ms);
    primary
        .checked_add(post_wait)
        .ok_or_else(|| AppError::invalid_input("Combined command budget is too large"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn queue_time_is_not_refunded_and_expiry_is_terminal() {
        assert_eq!(
            remaining_at(8000, 2000).unwrap(),
            Duration::from_nanos(6000)
        );
        for now in [8000, 9000] {
            assert_eq!(remaining_at(8000, now).unwrap_err().code(), "TIMEOUT");
        }
    }

    #[test]
    fn budgets_follow_typed_arguments_including_post_action_waits() {
        for (args, expected) in [
            (vec!["ad", "click", "@s123:e1", "--timeout-ms", "123"], 123),
            (
                vec!["ad", "click", "@s123:e1", "--timeout-ms", "0"],
                agent_desktop_core::DEFAULT_OPERATION_TIMEOUT_MS,
            ),
            (
                vec!["ad", "wait", "--text", "absent", "--timeout", "250"],
                250,
            ),
            (vec!["ad", "snapshot", "--timeout-ms", "30000"], 30000),
            (vec!["ad", "find", "--timeout-ms", "30000"], 30000),
            (vec!["ad", "list-apps", "--timeout-ms", "30000"], 30000),
            (vec!["ad", "list-windows", "--timeout-ms", "30000"], 30000),
            (vec!["ad", "wait", "100"], 5100),
            (vec!["ad", "batch", "[]", "--timeout-ms", "80000"], 80000),
            (
                vec![
                    "ad",
                    "click",
                    "@s123:e1",
                    "--wait-for",
                    "button",
                    "--wait-timeout",
                    "900",
                ],
                5900,
            ),
        ] {
            let mut cli = crate::Cli::try_parse_from(args).unwrap();
            let command = cli.command.take().unwrap();
            assert_eq!(budget_ms(&cli, &command).unwrap(), expected);
        }
    }
}
