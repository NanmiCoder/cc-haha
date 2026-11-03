#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod batch;
mod cli;
mod cli_args;
#[cfg(target_os = "macos")]
mod command_host;
mod command_policy;
mod diagnostic;
mod dispatch;
mod visual_debug;

/// Shared blanket-default `PlatformAdapter` test double, sourced once from
/// `tests/support/noop_ops.rs` (also consumed by the standalone
/// `conformance` integration-test crate) and reused by any in-crate unit
/// test that needs "some adapter" without exercising a live capability.
#[cfg(test)]
#[path = "../tests/support/noop_ops.rs"]
mod test_noop_ops;

use agent_desktop_core::{
    AdapterError, AppError, DeliverySemantics, ErrorCode, SystemOps,
    context::{CommandContext, WaitSelector},
    response::output::{ErrorPayload, Response},
    session::resolve_active_session,
};
use clap::{CommandFactory, Parser};
use cli::{Cli, Commands};
use cli_args::skills::SkillsAction;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

const EXIT_INVALID_ARGS: u8 = 2;

fn main() -> ExitCode {
    #[cfg(target_os = "macos")]
    if command_host::is_host_process() {
        unsafe { libc::umask(0o077) };
    }
    let code = run_command();
    #[cfg(target_os = "linux")]
    agent_desktop_linux::end_input_session();
    code
}

fn run_command() -> ExitCode {
    if let Some(result) = build_adapter().run_cursor_overlay_child() {
        return if result.is_ok() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }
    #[cfg(target_os = "macos")]
    if let Some(exit_code) = run_permission_prompt_helper() {
        return exit_code;
    }
    #[cfg(target_os = "macos")]
    if let Some(exit_code) = agent_desktop_macos::permission_guide_from_env() {
        return ExitCode::from(exit_code);
    }
    #[cfg(target_os = "macos")]
    if command_host::is_host_process() {
        init_tracing(false);
        return match command_host::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(AppError::Io(error)) => report_output_failure(error),
            Err(error) => finish("host", Err(error)),
        };
    }
    run()
}

#[cfg(target_os = "macos")]
fn run_permission_prompt_helper() -> Option<ExitCode> {
    let (exit_code, response) = agent_desktop_macos::permission_prompt_helper_from_env()?;
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let result = writer
        .write_all(response.as_bytes())
        .and_then(|()| writer.write_all(b"\n"))
        .and_then(|()| writer.flush());
    Some(match result {
        Ok(()) => ExitCode::from(exit_code),
        Err(error) => report_output_failure(error),
    })
}

fn run() -> ExitCode {
    #[cfg(target_os = "windows")]
    let _ = agent_desktop_core::install_private_file_ops(Box::new(
        agent_desktop_windows::WindowsPrivateFile,
    ));

    let mut cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            if matches!(
                e.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                return match e.print() {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(write_err) => report_output_failure(write_err),
                };
            }
            let summary = diagnostic::clap_error_summary(&e.to_string());
            let error = AppError::invalid_input(diagnostic::bounded_text(&summary, 512));
            let command_name = diagnostic::clap_command_name(std::env::args().skip(1));
            return if let Err(write_err) = emit_response(&Response::err(
                &command_name,
                ErrorPayload::from_app_error(&error),
            )) {
                report_output_failure(write_err)
            } else {
                ExitCode::from(EXIT_INVALID_ARGS)
            };
        }
    };

    init_tracing(cli.visual_debug.verbose);

    let cmd = match cli.command.take() {
        Some(c) => c,
        None => {
            return match Cli::command().print_help() {
                Ok(()) => ExitCode::SUCCESS,
                Err(write_err) => report_output_failure(write_err),
            };
        }
    };

    let cmd_name = cmd.name();
    #[cfg(target_os = "macos")]
    if !cmd.needs_caller_process() {
        return match command_host::forward(&cli, &cmd) {
            Ok(response) => match emit_response(&response) {
                Err(error) => report_output_failure(error),
                Ok(()) if response["ok"] == true => ExitCode::SUCCESS,
                Ok(()) => ExitCode::FAILURE,
            },
            Err(error) => finish(cmd_name, Err(error)),
        };
    }
    finish(cmd_name, execute(cli, cmd))
}

fn execute(cli: Cli, cmd: Commands) -> Result<serde_json::Value, AppError> {
    execute_with_deadline(cli, cmd, None, None)
}

fn execute_with_deadline(
    cli: Cli,
    cmd: Commands,
    deadline: Option<agent_desktop_core::Deadline>,
    baseline: Option<agent_desktop_core::SignalBaseline>,
) -> Result<serde_json::Value, AppError> {
    if let Some(deadline) = deadline.filter(|deadline| deadline.is_expired()) {
        return Err(pre_dispatch_error(deadline.timeout_error().into()));
    }
    cli.visual_debug.validate(&cmd)?;
    agent_desktop_core::validate_state_root_env().map_err(pre_dispatch_error)?;
    match cmd {
        Commands::Version => {
            agent_desktop_core::commands::version::execute().map_err(pre_dispatch_error)
        }
        Commands::Skills(a) => {
            let result = match a.action.unwrap_or(SkillsAction::List) {
                SkillsAction::List => agent_desktop_core::commands::skills::list(),
                SkillsAction::Path => agent_desktop_core::commands::skills::path(),
                SkillsAction::Get(g) => agent_desktop_core::commands::skills::get(
                    agent_desktop_core::commands::skills::GetArgs {
                        name: g.name,
                        full: g.full,
                        reference: g.reference,
                    },
                ),
            };
            result.map_err(pre_dispatch_error)
        }
        cmd => {
            let wait_selector = build_wait_selector(&cli)?;
            let session_id = resolve_active_session(
                cli.identity.session.as_deref(),
                std::env::var("AGENT_DESKTOP_SESSION").ok().as_deref(),
            )
            .map_err(pre_dispatch_error)?;
            let context = CommandContext::new(session_id, cli.trace, cli.trace_strict)
                .map_err(pre_dispatch_error)?
                .with_headed(cli.interaction.headed)
                .with_wait_selector(wait_selector.clone());
            let agent_id = cli
                .identity
                .agent_id
                .clone()
                .or_else(|| std::env::var("AGENT_DESKTOP_AGENT_ID").ok());
            let mut context = context
                .with_agent_id(agent_id)
                .map_err(pre_dispatch_error)?;
            #[cfg(target_os = "macos")]
            if command_host::is_host_process() {
                context = context.with_pinned_session_namespace();
            }
            if let Some(deadline) = deadline {
                context = context.with_inherited_deadline(deadline);
            }
            context = context.with_event_baseline(baseline.map(Ok));
            if let Some(wait) = wait_selector.as_ref() {
                validate_wait_for_command(&cmd, wait)?;
            }
            execute_with_adapter(cmd, &context, &cli.visual_debug, deadline)
        }
    }
}

fn build_wait_selector(cli: &Cli) -> Result<Option<WaitSelector>, AppError> {
    let query = cli
        .post_action_wait
        .wait_for
        .as_ref()
        .map(|raw| (raw, false))
        .or_else(|| {
            cli.post_action_wait
                .wait_for_gone
                .as_ref()
                .map(|raw| (raw, true))
        });
    let Some((query_raw, gone)) = query else {
        if cli.post_action_wait.wait_timeout.is_some() {
            return Err(AppError::invalid_input_with_suggestion(
                "--wait-timeout requires --wait-for or --wait-for-gone",
                "Add a selector wait flag or remove --wait-timeout",
            ));
        }
        return Ok(None);
    };
    Ok(Some(WaitSelector {
        query_raw: query_raw.clone(),
        gone,
        timeout_ms: cli.post_action_wait.wait_timeout.unwrap_or(30_000),
    }))
}

fn validate_wait_for_command(cmd: &Commands, wait: &WaitSelector) -> Result<(), AppError> {
    if !cmd.supports_post_action_wait() {
        return Err(AppError::invalid_input_with_suggestion(
            format!(
                "Command '{}' does not support --wait-for or --wait-for-gone",
                cmd.name()
            ),
            "Use snapshot --wait-for \"<selector>\" or a supported ref action (click, type, …).",
        ));
    }
    agent_desktop_core::commands::query::validate_selector(&wait.query_raw)?;
    Ok(())
}

fn execute_with_adapter(
    mut cmd: Commands,
    context: &CommandContext,
    debug: &visual_debug::options::DebugOptions,
    deadline: Option<agent_desktop_core::Deadline>,
) -> Result<serde_json::Value, AppError> {
    #[cfg(target_os = "windows")]
    if let Err(bootstrap_error) = agent_desktop_windows::ensure_owned_process_mta_and_dpi() {
        return Err(pre_dispatch_error(bootstrap_error.into()));
    }

    let adapter = build_adapter();
    let adapter: &dyn agent_desktop_core::PlatformAdapter = &adapter;
    let report = if command_policy::requires_permission_report(&cmd) {
        match deadline
            .map_or_else(agent_desktop_core::Deadline::standard, Ok)
            .map_err(AppError::from)
            .and_then(|deadline| adapter.permission_report(deadline).map_err(AppError::from))
        {
            Ok(report) => report,
            Err(err) => return Err(pre_dispatch_error(err)),
        }
    } else {
        agent_desktop_core::PermissionReport::default()
    };
    command_policy::preflight(&cmd, &report)?;
    command_policy::preflight_context(&cmd, context)?;

    if debug.debug && report.screen_recording_denied() {
        return Err(pre_dispatch_error(
            AdapterError::new(
                ErrorCode::PermDenied,
                "Visual debug requires Screen Recording permission",
            )
            .with_suggestion(
                report
                    .screen_recording_suggestion()
                    .unwrap_or("Grant Screen Recording permission and retry"),
            )
            .into(),
        ));
    }
    let capture = match visual_debug::DebugCapture::prepare(&mut cmd, debug, adapter, context) {
        Ok(capture) => capture,
        Err(error) => return Err(pre_dispatch_error(error)),
    };
    if let Some(deadline) = deadline.filter(|deadline| deadline.is_expired()) {
        return Err(pre_dispatch_error(deadline.timeout_error().into()));
    }
    let mut result = dispatch::dispatch(cmd, adapter, &report, context);
    if let Some(capture) = capture {
        capture.finish(&mut result, adapter, context);
    }
    result
}

fn pre_dispatch_error(error: AppError) -> AppError {
    match error {
        AppError::Adapter(mut source) => {
            source.disposition = DeliverySemantics::not_delivered();
            source.into()
        }
        other => AdapterError::new(ErrorCode::Internal, other.to_string())
            .with_disposition(DeliverySemantics::not_delivered())
            .into(),
    }
}

fn finish(cmd_name: &str, result: Result<serde_json::Value, AppError>) -> ExitCode {
    let response = response(cmd_name, result);
    if let Err(write_err) = emit_response(&response) {
        return report_output_failure(write_err);
    }
    if response.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn response(cmd_name: &str, result: Result<serde_json::Value, AppError>) -> Response {
    match result {
        Ok(data) => Response::ok(cmd_name, data),
        Err(error) => Response::err(cmd_name, ErrorPayload::from_app_error(&error)),
    }
}

fn report_output_failure(write_err: std::io::Error) -> ExitCode {
    eprintln!("agent-desktop: failed to write response to stdout: {write_err}");
    ExitCode::FAILURE
}

fn emit_response(response: &impl serde::Serialize) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    serde_json::to_writer(&mut writer, response).map_err(std::io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn build_adapter() -> impl agent_desktop_core::PlatformAdapter {
    #[cfg(target_os = "macos")]
    {
        agent_desktop_macos::MacOSAdapter::new()
    }

    #[cfg(target_os = "windows")]
    {
        agent_desktop_windows::WindowsAdapter::new()
    }

    #[cfg(target_os = "linux")]
    {
        agent_desktop_linux::release_input_on_signals();
        agent_desktop_linux::LinuxAdapter::new()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    compile_error!("Unsupported platform")
}

fn init_tracing(verbose: bool) {
    use tracing_subscriber::{EnvFilter, fmt};
    let filter = if verbose { "debug" } else { "warn" };
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(filter)),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
}

#[cfg(test)]
#[path = "tests/main_tests.rs"]
mod main_tests;
