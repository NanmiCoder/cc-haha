use crate::{
    AppError,
    commands::{wait::WaitArgs, wait_predicate, wait_surface::SurfaceWait},
    refs::validate_ref_id,
};

pub(crate) enum WaitMode {
    Sleep(u64),
    Element {
        ref_id: String,
        predicate: wait_predicate::ElementPredicate,
    },
    Window {
        title: String,
        app: Option<String>,
    },
    Text {
        text: String,
        count: Option<usize>,
        app: Option<String>,
    },
    Menu {
        app: Option<String>,
        open: bool,
    },
    Notification {
        app: Option<String>,
        text: Option<String>,
    },
    Event {
        event: String,
        app: Option<String>,
        window_id: Option<String>,
        window_title: Option<String>,
    },
}

impl WaitMode {
    pub(crate) fn from_args(args: WaitArgs) -> Result<Self, AppError> {
        validate_wait_mode(&args)?;
        if let Some(ms) = args.mode.ms {
            return Ok(Self::Sleep(ms));
        }
        match args.mode.surface {
            Some(SurfaceWait::Menu) => {
                return Ok(Self::Menu {
                    app: args.app,
                    open: true,
                });
            }
            Some(SurfaceWait::MenuClosed) => {
                return Ok(Self::Menu {
                    app: args.app,
                    open: false,
                });
            }
            Some(SurfaceWait::Notification) => {
                return Ok(Self::Notification {
                    app: args.app,
                    text: args.mode.text,
                });
            }
            None => {}
        }
        if let Some(event) = args.mode.event {
            return Ok(Self::Event {
                event,
                app: args.app,
                window_id: args.mode.window_id,
                window_title: args.mode.window,
            });
        }
        if let Some(ref_id) = args.mode.element {
            validate_ref_id(&ref_id)?;
            let predicate = wait_predicate::ElementPredicate::parse(
                args.predicate.predicate.as_deref(),
                args.predicate.value,
                args.predicate.action.as_deref(),
            )?;
            return Ok(Self::Element { ref_id, predicate });
        }
        if let Some(title) = args.mode.window {
            return Ok(Self::Window {
                title,
                app: args.app,
            });
        }
        if let Some(text) = args.mode.text {
            return Ok(Self::Text {
                text,
                count: args.predicate.count,
                app: args.app,
            });
        }
        Err(missing_wait_mode())
    }
}

/// `--window` is dual-purposed: alone it selects `WaitMode::Window`, but
/// alongside `--event` it narrows the event wait to a specific window title
/// instead of choosing a second mode — so it is excluded from the
/// exactly-one-mode count whenever `--event` is also present.
pub(crate) fn validate_wait_mode(args: &WaitArgs) -> Result<(), AppError> {
    if args.predicate.predicate.is_some() && args.mode.element.is_none() {
        return Err(AppError::invalid_input_with_suggestion(
            "--predicate requires --element",
            "Use --element <ref> with --predicate, or remove --predicate.",
        ));
    }
    if args.predicate.value.is_some() && args.mode.element.is_none() {
        return Err(AppError::invalid_input_with_suggestion(
            "--value requires --element and --predicate value",
            "Use --element <ref> --predicate value --value <expected>.",
        ));
    }
    let waits_for_notification = matches!(args.mode.surface, Some(SurfaceWait::Notification));
    if args.predicate.count.is_some() && (args.mode.text.is_none() || waits_for_notification) {
        return Err(AppError::invalid_input_with_suggestion(
            "--count is only valid for --text waits",
            "Use --text <text> --count <expected> without --notification, or remove --count.",
        ));
    }
    validate_event_filters(args)?;
    let selected = [
        args.mode.ms.is_some(),
        args.mode.element.is_some(),
        args.mode.window.is_some() && args.mode.event.is_none(),
        args.mode.text.is_some() && !waits_for_notification,
        args.mode.surface.is_some(),
        args.mode.event.is_some(),
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count();
    if selected == 1 {
        return Ok(());
    }
    if selected == 0 {
        return Err(missing_wait_mode());
    }
    Err(ambiguous_wait_mode())
}

pub(crate) fn ambiguous_wait_mode() -> AppError {
    AppError::invalid_input_with_suggestion(
        "wait accepts exactly one mode",
        "Use one of: ms, --element, --window, --text, --menu, --menu-closed, --notification, or --event.",
    )
}

fn validate_event_filters(args: &WaitArgs) -> Result<(), AppError> {
    let Some(token) = args.mode.event.as_deref() else {
        return Ok(());
    };
    let event = crate::commands::wait_event::parse_event_kind(token)?;
    let has_window_filter = args.mode.window.is_some() || args.mode.window_id.is_some();
    let supports_window_filter = matches!(
        &event,
        crate::EventKind::WindowOpened
            | crate::EventKind::WindowClosed
            | crate::EventKind::FocusChangedWindow
    );
    if has_window_filter && !supports_window_filter {
        return Err(AppError::invalid_input_with_suggestion(
            format!("--event {token} does not carry window identity"),
            "Remove --window and --window-id, or choose a window lifecycle event.",
        ));
    }
    let is_surface = matches!(
        &event,
        crate::EventKind::SurfaceAppeared { .. } | crate::EventKind::SurfaceDismissed { .. }
    );
    if is_surface && args.app.is_none() {
        return Err(AppError::invalid_input_with_suggestion(
            format!("--event {token} requires --app"),
            "Add --app <name> so the adapter can inspect that application's surfaces.",
        ));
    }
    Ok(())
}

fn missing_wait_mode() -> AppError {
    AppError::invalid_input(
        "Provide a duration (ms), --menu, --notification, --event, --element <ref>, --window <title>, or --text <text>",
    )
}

#[cfg(test)]
#[path = "wait_mode_tests.rs"]
mod tests;
