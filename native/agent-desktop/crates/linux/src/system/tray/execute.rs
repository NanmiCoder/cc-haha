use agent_desktop_core::{
    Action, ActionRequest, ActionResult, AdapterError, DeliverySemantics, ErrorCode,
    InteractionLease,
};

use super::activate::{self, BusWire, Item};
use super::{TrayTarget, call, item, menu_event};

pub(crate) fn execute(
    target: &TrayTarget,
    request: ActionRequest,
    lease: &InteractionLease,
) -> Result<ActionResult, AdapterError> {
    let deadline = lease.deadline();
    let connection = call::session(deadline)?;
    call::require_owner(&connection, &target.owner, deadline)?;
    let evidence = item::read(&connection, target, deadline)?;
    if evidence.passive {
        return Err(
            AdapterError::new(ErrorCode::ActionFailed, "The tray item is hidden")
                .with_disposition(DeliverySemantics::not_delivered()),
        );
    }
    if target.entry_id.is_some() {
        if !matches!(request.action, Action::Click) {
            return Err(activate::unsupported_action(
                target.label_path.last().map_or("", String::as_str),
                &request.action,
            ));
        }
        return menu_event::deliver(&connection, target, deadline);
    }
    let wire = BusWire {
        connection: &connection,
        target,
        deadline,
    };
    let item = Item {
        title: &evidence.title,
        methods: &evidence.methods,
        request: &request,
    };
    activate::run(&item, &wire)
}
