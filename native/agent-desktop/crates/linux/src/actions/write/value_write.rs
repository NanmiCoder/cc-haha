use agent_desktop_core::{
    Action, ActionResult, AdapterError, DeliverySemantics, ErrorCode, InteractionPolicy,
};
use zbus::zvariant::{OwnedValue, Value};

use super::mutation::{WriteKind, WriteReply};
use super::numeric_write::{self, NumericPort, VALUE_INTERFACE};
use super::secure_write::is_secure;
use super::text_write::{self, EDITABLE_TEXT, TextPort, read_only_field, writable};
use super::write_call::{Call, invoke};
use crate::actions::chain::chain_def::ChainDef;
use crate::actions::chain::execute_chain;
use crate::actions::context::Target;
use crate::system::{PROPERTIES_INTERFACE, within};
use crate::tree::capabilities::action_read::NodeView;
use crate::tree::capabilities::text_selection::{CaretAndSelection, read_caret_and_selection};
use crate::tree::capabilities::text_units::LengthUnit;
use crate::tree::live_read::live_offscreen::toolkit_of;
use crate::tree::properties::toolkit_trust::{insert_length_unit, is_gecko};
use crate::tree::vocabulary::role_numbers::{DIAL, SCROLL_BAR, SLIDER, SPIN_BUTTON};
use crate::tree::vocabulary::state_bits::{EDITABLE, READ_ONLY};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    Numeric { spin_button: bool },
    Text,
    Unsupported,
}

fn advertises(interfaces: Option<&[String]>, name: &str) -> Option<bool> {
    interfaces.map(|names| names.iter().any(|advertised| advertised == name))
}

pub(crate) fn text_advertised(interfaces: Option<&[String]>) -> bool {
    advertises(interfaces, EDITABLE_TEXT) != Some(false)
}

pub(crate) fn route(role: Option<u32>, interfaces: Option<&[String]>) -> Route {
    let numeric = matches!(role, Some(SLIDER | SPIN_BUTTON | SCROLL_BAR | DIAL));
    if numeric && advertises(interfaces, VALUE_INTERFACE) == Some(true) {
        return Route::Numeric {
            spin_button: role == Some(SPIN_BUTTON),
        };
    }
    if text_advertised(interfaces) {
        Route::Text
    } else {
        Route::Unsupported
    }
}

struct LiveText<'a> {
    target: &'a Target<'a>,
}

impl LiveText<'_> {
    fn send<B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType>(
        &self,
        method: &'static str,
        body: &B,
        kind: WriteKind,
    ) -> Result<WriteReply, AdapterError> {
        self.target.deadline.ensure_remaining()?;
        invoke(
            self.target,
            Call {
                interface: EDITABLE_TEXT,
                method,
                body,
                kind,
            },
        )
    }
}

impl TextPort for LiveText<'_> {
    fn set_contents(&self, text: &str) -> Result<WriteReply, AdapterError> {
        self.send("SetTextContents", &(text,), WriteKind::SetTextContents)
    }

    fn delete(&self, start: i32, end: i32) -> Result<WriteReply, AdapterError> {
        self.send("DeleteText", &(start, end), WriteKind::DeleteText)
    }

    fn insert(&self, position: i32, text: &str, length: i32) -> Result<WriteReply, AdapterError> {
        self.send(
            "InsertText",
            &(position, text, length),
            WriteKind::InsertText,
        )
    }

    fn read(&self) -> Option<String> {
        let target = self.target;
        let view = target.view().ok()?;
        view.value().map(str::to_owned)
    }

    fn length_unit(&self) -> LengthUnit {
        let target = self.target;
        insert_length_unit(&toolkit_of(target.bus, target.element, target.deadline))
    }

    fn caret(&self) -> Result<Option<CaretAndSelection>, AdapterError> {
        let target = self.target;
        read_caret_and_selection(target.bus, target.element, target.deadline)
    }
}

struct LiveNumeric<'a> {
    target: &'a Target<'a>,
}

impl NumericPort for LiveNumeric<'_> {
    fn set(&self, value: f64) -> Result<WriteReply, AdapterError> {
        self.target.deadline.ensure_remaining()?;
        invoke(
            self.target,
            Call {
                interface: PROPERTIES_INTERFACE,
                method: "Set",
                body: &(VALUE_INTERFACE, "CurrentValue", Value::from(value)),
                kind: WriteKind::SetProperty,
            },
        )
    }

    fn stored(&self) -> Option<f64> {
        let target = self.target;
        let view = target.view().ok()?;
        view.value()?
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
    }
}

fn minimum_increment(target: &Target<'_>) -> Option<f64> {
    let connection = target.bus.get(target.deadline).ok()?;
    let read = async {
        let reply = connection
            .inner()
            .call_method(
                Some(target.element.bus_name()),
                target.element.path(),
                Some(PROPERTIES_INTERFACE),
                "Get",
                &(VALUE_INTERFACE, "MinimumIncrement"),
            )
            .await
            .ok()?;
        let value = reply.body().deserialize::<OwnedValue>().ok()?;
        value.downcast_ref::<f64>().ok()
    };
    within(target.deadline, async { Ok(read.await) })
        .ok()
        .flatten()
        .filter(|step| step.is_finite())
}

fn unsupported(action: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("The element has no way to {action} through accessibility"),
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

fn ensure_writable(view: &NodeView) -> Result<(), AdapterError> {
    if writable(view.state(READ_ONLY), view.state(EDITABLE)) {
        Ok(())
    } else {
        Err(read_only_field())
    }
}

fn ensure_toolkit_applies_writes(
    target: &Target<'_>,
    policy: InteractionPolicy,
    action: &str,
) -> Result<(), AdapterError> {
    if is_gecko(&toolkit_of(target.bus, target.element, target.deadline)) {
        return Err(text_write::editable_text_ignored(policy, action));
    }
    Ok(())
}

fn secure_view(view: &NodeView) -> bool {
    is_secure(view.role(), view.tokens(), view.secure())
}

const SET_VALUE: ChainDef = ChainDef {
    action: "set-value",
    suggestion: "Click the field and use type, or check that the field is editable",
};
const CLEAR: ChainDef = ChainDef {
    action: "clear",
    suggestion: "Click the field and select its text, or check that the field is editable",
};
const TYPE: ChainDef = ChainDef {
    action: "type",
    suggestion: "Focus the field and retry, or use set-value to replace the whole text",
};

pub(crate) fn set_value(
    target: &Target<'_>,
    text: &str,
    policy: InteractionPolicy,
) -> Result<ActionResult, AdapterError> {
    let view = target.view()?;
    match route(view.role(), view.interfaces()) {
        Route::Unsupported => Err(unsupported("set a value")),
        Route::Numeric { spin_button } => {
            if view.state(READ_ONLY) == Some(true) {
                return Err(unsupported("set a read-only value"));
            }
            let increment = spin_button.then(|| minimum_increment(target)).flatten();
            let plan = numeric_write::plan(text, spin_button, increment)?;
            let port = LiveNumeric { target };
            let mut rungs = numeric_write::write_rungs(&port, plan);
            execute_chain(&SET_VALUE, &mut rungs, target.deadline)
        }
        Route::Text => {
            ensure_writable(&view)?;
            ensure_toolkit_applies_writes(target, policy, SET_VALUE.action)?;
            let port = LiveText { target };
            let mut rungs = text_write::replace_rungs(&port, text, secure_view(&view));
            execute_chain(&SET_VALUE, &mut rungs, target.deadline)
        }
    }
}

pub(crate) fn clear(
    target: &Target<'_>,
    policy: InteractionPolicy,
) -> Result<ActionResult, AdapterError> {
    let view = target.view()?;
    if !text_advertised(view.interfaces()) {
        return Err(unsupported("clear"));
    }
    ensure_writable(&view)?;
    ensure_toolkit_applies_writes(target, policy, CLEAR.action)?;
    let port = LiveText { target };
    let mut rungs = text_write::replace_rungs(&port, "", secure_view(&view));
    execute_chain(&CLEAR, &mut rungs, target.deadline)
}

pub(crate) fn type_text(
    target: &Target<'_>,
    text: &str,
    policy: InteractionPolicy,
) -> Result<ActionResult, AdapterError> {
    let view = target.view()?;
    if !text_advertised(view.interfaces()) {
        return Err(crate::actions::click::no_semantic_verb(&Action::TypeText(
            String::new(),
        )));
    }
    ensure_writable(&view)?;
    ensure_toolkit_applies_writes(target, policy, TYPE.action)?;
    let port = LiveText { target };
    let mut rungs = text_write::insert_rungs(&port, text, secure_view(&view));
    execute_chain(&TYPE, &mut rungs, target.deadline)
}

#[cfg(test)]
#[path = "value_write_tests.rs"]
mod tests;
