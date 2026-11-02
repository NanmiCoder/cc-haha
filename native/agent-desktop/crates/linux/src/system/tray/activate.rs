use agent_desktop_core::{
    Action, ActionRequest, ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics,
    ErrorCode, StepMechanism,
};
use zbus::Connection;

use super::TrayTarget;
use super::call;

const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";

pub(crate) fn refusal(title: &str, action: &Action) -> AdapterError {
    let (verb, method) = match action {
        Action::RightClick => ("right-click", "ContextMenu"),
        _ => ("click", "Activate"),
    };
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("The tray item '{title}' lists no {method} method, so {verb} cannot be delivered"),
    )
    .with_suggestion(
        "Use an advertised menu entry; a title match cannot establish a native pointer receiver",
    )
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn unsupported_action(title: &str, action: &Action) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!(
            "The tray item '{title}' supports click and right-click, not {}",
            action.name()
        ),
    )
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// What an item action needs from the bus, so its rules run on a recording
/// fake.
pub(crate) trait ItemWire {
    fn owner_present(&self) -> Result<bool, AdapterError>;
    fn send(&self, method: &str) -> Result<(), AdapterError>;
}

pub(crate) struct BusWire<'a> {
    pub(crate) connection: &'a Connection,
    pub(crate) target: &'a TrayTarget,
    pub(crate) deadline: Deadline,
}

impl ItemWire for BusWire<'_> {
    fn owner_present(&self) -> Result<bool, AdapterError> {
        call::owner_alive(self.connection, &self.target.owner, self.deadline)
    }

    fn send(&self, method: &str) -> Result<(), AdapterError> {
        call::call(
            self.connection,
            call::Endpoint {
                destination: &self.target.owner,
                path: &self.target.object_path,
                interface: ITEM_INTERFACE,
            },
            method,
            &(0i32, 0i32),
            self.deadline,
        )
        .map(|_| ())
    }
}

pub(crate) struct Item<'a> {
    pub(crate) title: &'a str,
    pub(crate) methods: &'a [String],
    pub(crate) request: &'a ActionRequest,
}

fn step(label: &'static str, mechanism: StepMechanism) -> ActionStep {
    ActionStep::succeeded(label).with_mechanism(mechanism)
}

pub(crate) fn run(item: &Item<'_>, wire: &dyn ItemWire) -> Result<ActionResult, AdapterError> {
    let action = &item.request.action;
    let method = match action {
        Action::Click => "Activate",
        Action::RightClick => "ContextMenu",
        _ => return Err(unsupported_action(item.title, action)),
    };
    if !item.methods.iter().any(|listed| listed == method) {
        return Err(refusal(item.title, action));
    }
    if !wire.owner_present()? {
        return Err(call::owner_gone());
    }
    wire.send(method)?;
    Ok(ActionResult::from_execution(
        action,
        vec![step("sni-method", StepMechanism::SemanticApi)],
    ))
}

#[cfg(test)]
#[path = "activate_tests.rs"]
mod tests;
