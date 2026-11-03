use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use crate::actions::context::Target;
use crate::actions::write::mutation::{WriteKind, WriteReply};
use crate::actions::write::write_call::{Call, invoke};
use crate::system::{PROPERTIES_INTERFACE, within};
use crate::tree::AtspiElement;

pub(in crate::actions) const SELECTION_INTERFACE: &str = "org.a11y.atspi.Selection";

pub(in crate::actions) fn selected_count(holder: &Target<'_>) -> Option<i32> {
    let connection = holder.bus.get(holder.deadline).ok()?;
    let element = holder.element;
    within(holder.deadline, async {
        let reply = connection
            .inner()
            .call_method(
                Some(element.bus_name()),
                element.path(),
                Some(PROPERTIES_INTERFACE),
                "Get",
                &(SELECTION_INTERFACE, "NSelectedChildren"),
            )
            .await;
        Ok(reply.ok().and_then(|message| {
            let value = message.body().deserialize::<OwnedValue>().ok()?;
            i32::try_from(value).ok()
        }))
    })
    .ok()
    .flatten()
}

fn read_child(
    holder: &Target<'_>,
    interface: &str,
    method: &str,
    index: i32,
) -> Result<AtspiElement, AdapterError> {
    let connection = holder.bus.get(holder.deadline)?;
    let element = holder.element;
    within(holder.deadline, async {
        let reply = connection
            .inner()
            .call_method(
                Some(element.bus_name()),
                element.path(),
                Some(interface),
                method,
                &(index,),
            )
            .await
            .map_err(|error| AdapterError::internal(error.to_string()))?;
        let (name, path) = reply
            .body()
            .deserialize::<(String, OwnedObjectPath)>()
            .map_err(|error| AdapterError::internal(error.to_string()))?;
        Ok(AtspiElement::new(name, path.to_string(), element.pid()))
    })
}

pub(in crate::actions) fn selected_child(holder: &Target<'_>) -> Option<AtspiElement> {
    if selected_count(holder) != Some(1) {
        return None;
    }
    read_child(holder, SELECTION_INTERFACE, "GetSelectedChild", 0).ok()
}

pub(in crate::actions) fn needs_replacement(count: Option<i32>) -> bool {
    count.is_some_and(|count| count > 1)
}

pub(in crate::actions) fn exclusive_verdict(count: Option<i32>) -> Option<bool> {
    match count {
        Some(1) => Some(true),
        _ => None,
    }
}

pub(in crate::actions) fn replace_with_only(
    holder: &Target<'_>,
    item: &crate::tree::AtspiElement,
) -> Result<(), AdapterError> {
    super::select_index::resolve(holder, item)?;
    let cleared = invoke(
        holder,
        Call {
            interface: SELECTION_INTERFACE,
            method: "ClearSelection",
            body: &(),
            kind: WriteKind::ClearSelection,
        },
    )? == WriteReply::Done;
    if !cleared {
        return Err(replacement_refused());
    }
    match super::select_index::write(holder, item)
        .map_err(|error| error.with_disposition(DeliverySemantics::uncertain()))?
    {
        WriteReply::Done => Ok(()),
        WriteReply::Absent => Err(replacement_refused()),
    }
}

fn replacement_refused() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The container did not replace its selection with only the requested item",
    )
    .with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(test)]
#[path = "select_exclusive_tests.rs"]
mod tests;
