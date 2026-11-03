use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::combo::{ensure_combo_allowed, parse_combo_normalized},
    context::CommandContext,
};
use serde_json::Value;

pub struct PressArgs {
    pub combo: String,
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub force: bool,
}

pub fn execute(
    args: PressArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    super::helpers::validate_post_action_wait(context)?;
    let combo = parse_combo_normalized(&args.combo)?;
    ensure_combo_allowed(&combo, &args.combo, args.force, adapter)?;
    let deadline = crate::Deadline::standard()?;

    let mut pressed_process = None;
    let result = if let Some((expected, window)) = target_app(&args, adapter, deadline)? {
        let lease = adapter.acquire_interaction_lease(deadline)?;
        let live = crate::commands::helpers::revalidate_app_for_mutation(
            adapter,
            &expected,
            lease.deadline(),
        )?;
        let process = crate::commands::helpers::process_identity(&live)?;
        pressed_process = Some(process.pid);
        if context.physical_input_policy().is_headed() {
            match &window {
                Some(window) => crate::actions::headed_focus::focus_exact_window(
                    window, adapter, context, &lease,
                )?,
                None => crate::actions::headed_focus::focus_process_window(
                    process.clone(),
                    adapter,
                    context,
                    &lease,
                )?,
            };
        }
        if !context.physical_input_policy().is_headed()
            && let Some(window) = &window
        {
            adapter.press_key_for_window(window, &combo, context.physical_input_policy(), &lease)?
        } else {
            adapter.press_key_for_app(process, &combo, context.physical_input_policy(), &lease)?
        }
    } else {
        let lease = adapter.acquire_interaction_lease(deadline)?;
        let handle = crate::adapter::NativeHandle::null();
        adapter.execute_action(
            &handle,
            context.request_base(Action::PressKey(combo)),
            &lease,
        )?
    };
    crate::cursor_overlay::follow_caret_after_key(adapter, context, pressed_process);
    super::helpers::apply_scoped_post_action_wait(
        serde_json::to_value(result)?,
        args.app,
        args.window_id,
        adapter,
        context,
    )
}

fn target_app(
    args: &PressArgs,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Option<(crate::AppInfo, Option<crate::WindowInfo>)>, AppError> {
    if let Some(window_id) = &args.window_id {
        let window = crate::snapshot::resolve_window(
            adapter,
            args.app.as_deref(),
            Some(window_id),
            deadline,
        )?;
        let app = crate::system::app_lookup::resolve_app_owning(&window, adapter, deadline)?;
        return Ok(Some((app, Some(window))));
    }
    args.app
        .as_deref()
        .map(|app| crate::commands::helpers::resolve_app(Some(app), adapter, deadline))
        .transpose()
        .map(|app| app.map(|app| (app, None)))
}

#[cfg(test)]
#[path = "press_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "press_window_tests.rs"]
mod window_tests;
