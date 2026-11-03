use std::time::Duration;

use agent_desktop_core::{
    Action, ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode,
};
use serde_json::json;
use zbus::zvariant::{OwnedValue, Structure, Value};

use super::action_call::resolve_verb;
use super::chain::chain_def::ChainDef;
use super::chain::chain_delivery_outcome::DeliveryOutcome;
use super::chain::chain_observed::Observed;
use super::chain::chain_rung::Rung;
use super::chain::execute_chain;
use super::click::{POLL_STEP, invoke_verb, names_of, observed_of, poll_until, refusal};
use super::context::Target;
use super::select::select_exclusive::{SELECTION_INTERFACE, selected_count};
use super::select::select_pointer::{Pointer, after_unproven_index};
use super::select::select_pointer_combo::{is_pointer_combo, select_in_pointer_combo};
use super::select::select_popup::{is_popup_dropdown, select_in_popup};
use super::select::select_row::click_row;
use super::select::select_search::{Container, Hit, Inspected, ItemReader, Search, search};
use super::select::select_verify::{commit_unobserved, read_verification};
use super::write::mutation::WriteReply;
use crate::system::{ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, SharedBus, within};
use crate::tree::capabilities::action_names::{click_verbs, selection_verbs};
use crate::tree::capabilities::action_read::{NodeView, read_node_view};
use crate::tree::live_read::live_offscreen::toolkit_of;
use crate::tree::properties::toolkit_trust::is_gecko;
use crate::tree::vocabulary::role_numbers::COMBO_BOX;
use crate::tree::vocabulary::state_bits::{CHECKABLE, SELECTABLE, SELECTED};
use crate::tree::{AtspiElement, atspi_element, element::ancestry, list_children};

pub(super) const SELECT_SETTLE: Duration = Duration::from_millis(1000);
const SELECT_CHILD_LABEL: &str = "Selection.SelectChild";
const SELECT_VERB_LABEL: &str = "Action.DoAction";
const SELECT_SUGGESTION: &str =
    "Refresh the snapshot and inspect the element before deciding whether to retry.";

pub(super) struct BusReader<'a> {
    pub(super) bus: &'a SharedBus,
    pub(super) deadline: Deadline,
    pub(super) inspected_role: Option<u32>,
}

pub(super) fn handle_of(element: &AtspiElement) -> agent_desktop_core::NativeHandle {
    element.clone().into_native_handle()
}

impl ItemReader for BusReader<'_> {
    type Node = AtspiElement;

    fn inspect(&mut self, node: &AtspiElement) -> Result<Inspected, AdapterError> {
        let view = read_node_view(self.bus, &handle_of(node), self.deadline)?;
        self.inspected_role = view.role();
        let selection = advertises_selection(&view);
        Ok(Inspected {
            name: view.name().map(str::to_owned),
            selection,
            selectable: selection || names_select_verb(&view),
        })
    }

    fn children(&mut self, node: &AtspiElement) -> Result<Vec<AtspiElement>, AdapterError> {
        children_of(self.bus, node, self.inspected_role, self.deadline)
    }
}

pub(super) fn advertises_selection(view: &NodeView) -> bool {
    view.interfaces()
        .is_some_and(|names| names.iter().any(|name| name == SELECTION_INTERFACE))
}

fn names_select_verb(view: &NodeView) -> bool {
    view.action_names()
        .is_some_and(|names| resolve_verb(names, select_verbs(view)).is_some())
}

fn select_verbs(view: &NodeView) -> &'static [&'static str] {
    selection_verbs(view.role(), view.state(SELECTABLE), view.state(CHECKABLE))
}

pub(super) fn children_of(
    bus: &SharedBus,
    node: &AtspiElement,
    role: Option<u32>,
    deadline: Deadline,
) -> Result<Vec<AtspiElement>, AdapterError> {
    let connection = bus.get(deadline)?;
    let children = within(deadline, async {
        list_children(connection.inner(), node).await
    })?;
    Ok(children
        .into_iter()
        .map(|(name, path)| {
            let mut child = AtspiElement::new(name, path, node.pid());
            child.set_ancestry(ancestry::child(node, role));
            child
        })
        .collect())
}

pub(super) fn parent_of(
    bus: &SharedBus,
    node: &AtspiElement,
    deadline: Deadline,
) -> Result<Option<AtspiElement>, AdapterError> {
    let connection = bus.get(deadline)?;
    within(deadline, async {
        let reply = connection
            .inner()
            .call_method(
                Some(node.bus_name()),
                node.path(),
                Some(PROPERTIES_INTERFACE),
                "Get",
                &(ACCESSIBLE_INTERFACE, "Parent"),
            )
            .await;
        let parent = reply.ok().and_then(|message| {
            let value = message.body().deserialize::<OwnedValue>().ok()?;
            let structure = Structure::try_from(value).ok()?;
            match structure.fields() {
                [Value::Str(name), Value::ObjectPath(path)] => {
                    let mut parent =
                        AtspiElement::new(name.to_string(), path.to_string(), node.pid());
                    parent.set_ancestry(node.ancestry().clone());
                    Some(parent)
                }
                _ => None,
            }
        });
        Ok(parent)
    })
}

fn selection_parent(
    reader: &mut BusReader<'_>,
    node: &AtspiElement,
) -> Result<Option<Container<AtspiElement>>, AdapterError> {
    let Some(parent) = parent_of(reader.bus, node, reader.deadline)? else {
        return Ok(None);
    };
    if !reader.inspect(&parent)?.selection {
        return Ok(None);
    }
    let siblings = reader.children(&parent)?;
    let present = siblings
        .iter()
        .any(|sibling| sibling.bus_name() == node.bus_name() && sibling.path() == node.path());
    Ok(present.then_some(Container { node: parent }))
}

pub(super) fn container_target<'a>(
    parent: &Target<'a>,
    handle: &'a agent_desktop_core::NativeHandle,
) -> Result<Target<'a>, AdapterError> {
    Ok(Target {
        bus: parent.bus,
        handle,
        element: atspi_element(handle)?,
        deadline: parent.deadline,
    })
}

fn select_through(
    target: &Target<'_>,
    hit: &Hit<AtspiElement>,
    container: Option<&Container<AtspiElement>>,
    display_value: &str,
) -> Result<ActionResult, AdapterError> {
    let action = Action::Select(display_value.to_owned());
    let verified_node = hit.row.clone().unwrap_or_else(|| hit.item.clone());
    let item_handle = handle_of(&hit.item);
    let item = container_target(target, &item_handle)?;
    let view = item.view()?;
    let names = names_of(&view)?;
    let verbs = if resolve_verb(names, select_verbs(&view)).is_none()
        && hit.row.as_ref().is_some_and(|row| {
            row.bus_name() == hit.item.bus_name() && row.path() == hit.item.path()
        }) {
        click_verbs(view.role())
    } else {
        select_verbs(&view)
    };
    let own_verb = resolve_verb(names, verbs).is_some();
    let holder_handle = container.map(|container| handle_of(&container.node));
    let holder = match (&holder_handle, hit.own) {
        (Some(handle), false) => Some(container_target(target, handle)?),
        _ => None,
    };
    let application_fires_no_change =
        is_gecko(&toolkit_of(target.bus, target.element, target.deadline));
    let observe = || -> Result<Option<bool>, AdapterError> {
        let verified = poll_until(
            target.deadline,
            SELECT_SETTLE,
            POLL_STEP,
            || {
                read_verification(
                    target.bus,
                    target,
                    &verified_node,
                    display_value,
                    holder.as_ref(),
                )
            },
            |verified| *verified == Some(true),
        );
        Ok(verified)
    };
    let finish = |outcome| {
        let outcome = match (&holder, outcome) {
            (Some(holder), DeliveryOutcome::Delivered(Observed::Matched)) => {
                let verified =
                    select_verb::keep_only_the_item(target, holder, &verified_node, display_value)?;
                DeliveryOutcome::Delivered(observed_of(verified))
            }
            (_, other) => other,
        };
        Ok(match outcome {
            DeliveryOutcome::Delivered(Observed::Matched) => DeliveryOutcome::Delivered(
                observed_of(commit_unobserved(application_fires_no_change, Some(true))),
            ),
            other => other,
        })
    };
    let deliver = |reply: Result<WriteReply, AdapterError>| {
        Ok(match reply? {
            WriteReply::Absent => DeliveryOutcome::NotDelivered,
            WriteReply::Done => DeliveryOutcome::Delivered(observed_of(observe()?)),
        })
        .and_then(finish)
    };
    let mut rungs = Vec::new();
    if let Some(holder) = &holder {
        let verified_node = &verified_node;
        let deliver = &deliver;
        rungs.push(Rung {
            label: SELECT_CHILD_LABEL,
            run: Box::new(move || {
                let reply = super::select::select_index::write(holder, verified_node);
                deliver(reply).and_then(unchanged_is_ignored)
            }),
        });
    }
    if own_verb {
        rungs.insert(
            0,
            Rung {
                label: SELECT_VERB_LABEL,
                run: Box::new(|| {
                    select_verb::deliver(
                        resolve_verb(names, verbs).is_some_and(|index| {
                            names[index as usize].eq_ignore_ascii_case("toggle")
                        }),
                        view.state(SELECTED),
                        || holder.as_ref().map(selected_count),
                        || invoke_verb(&item, &action, names, verbs),
                        observe,
                    )
                    .and_then(finish)
                    .and_then(unchanged_is_ignored)
                }),
            },
        );
    }
    if rungs.is_empty() {
        return Err(no_route());
    }
    let def = ChainDef {
        action: action.name(),
        suggestion: SELECT_SUGGESTION,
    };
    execute_chain(&def, &mut rungs, target.deadline)
}

pub(super) fn unchanged_is_ignored(
    outcome: DeliveryOutcome,
) -> Result<DeliveryOutcome, AdapterError> {
    match outcome {
        DeliveryOutcome::Delivered(Observed::Unchanged) => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "The selection write was accepted but the requested choice was not observed",
        )
        .with_suggestion("Inspect the current selection, take a fresh snapshot, and choose an item that advertises a selection or activation action")
        .with_details(json!({ "cause": "write_ignored" }))
        .with_disposition(DeliverySemantics::delivered_unverified())),
        other => Ok(other),
    }
}

pub(super) fn no_route() -> AdapterError {
    refusal(
        ErrorCode::ActionNotSupported,
        "The element has no Selection interface and no selectable item, so a select has no semantic route",
        json!({ "selection_route": "absent" }),
    )
}

pub(super) fn miss_error(miss: &Search<AtspiElement>) -> AdapterError {
    match miss {
        Search::Found(_) => AdapterError::internal("a found item is not a miss"),
        Search::Ambiguous => {
            AdapterError::ambiguous_target("More than one item matches the requested value")
        }
        Search::NotFound { selectable: false } => no_route(),
        Search::NotFound { selectable: true } => refusal(
            ErrorCode::ElementNotFound,
            "No item in the selectable container matches the requested value",
            json!({ "searched": true }),
        ),
        Search::Incomplete => refusal(
            ErrorCode::AmbiguousTarget,
            "The search for the item ended at its limit before it covered the container",
            json!({ "search_incomplete": true }),
        ),
    }
}

pub(crate) fn select(
    target: &Target<'_>,
    display_value: &str,
    pointer: Option<&dyn Pointer>,
) -> Result<ActionResult, AdapterError> {
    let view = target.view()?;
    if is_popup_dropdown(target, &view)? {
        return select_in_popup(target, display_value);
    }
    if is_pointer_combo(&view) {
        return select_in_pointer_combo(target, display_value, pointer);
    }
    let mut reader = BusReader {
        bus: target.bus,
        deadline: target.deadline,
        inspected_role: None,
    };
    match search(&mut reader, target.element, display_value)? {
        Search::Found(hit) => {
            let container = if hit.own {
                let own_names_verb = names_select_verb(&view);
                if own_names_verb {
                    None
                } else {
                    selection_parent(&mut reader, target.element)?
                }
            } else {
                let combo = view.role() == Some(COMBO_BOX) && advertises_selection(&view);
                hit.container.clone().map(|container| match combo {
                    true => Container {
                        node: target.element.clone(),
                    },
                    false => container,
                })
            };
            let hit = Hit {
                own: hit.own && container.is_none(),
                ..hit
            };
            if (view.role() == Some(COMBO_BOX) || target.element.ancestry().combo_owner().is_some())
                && crate::tree::properties::toolkit_trust::kind(&toolkit_of(
                    target.bus,
                    target.element,
                    target.deadline,
                )) == crate::tree::properties::toolkit_trust::ToolkitKind::Qt
            {
                return click_row(
                    target,
                    &hit,
                    display_value,
                    pointer.ok_or_else(select_pointer::pointer_required)?,
                );
            }
            after_unproven_index(
                pointer,
                || select_through(target, &hit, container.as_ref(), display_value),
                |pointer| click_row(target, &hit, display_value, pointer),
            )
        }
        miss => Err(miss_error(&miss)),
    }
}

pub(crate) mod select_exclusive;
pub(super) mod select_identity;
pub(super) mod select_index;
pub(crate) mod select_pointer;
pub(super) mod select_pointer_combo;
pub(crate) mod select_popup;
pub(super) mod select_row;
pub(crate) mod select_search;
mod select_verb;
pub(crate) mod select_verify;
#[cfg(test)]
#[path = "select_tests.rs"]
mod tests;
