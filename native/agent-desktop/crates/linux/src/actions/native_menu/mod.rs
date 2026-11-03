//! L41-17: activate process-bound GTK exports outside the nested AT-SPI dispatcher.

use std::collections::HashMap;

use agent_desktop_core::{ActionResult, AdapterError, DeliverySemantics, ErrorCode};
use futures_util::future::join_all;
use serde_json::json;
use zbus::proxy::MethodFlags;
use zbus::zvariant::{OwnedValue, Signature};

use super::chain::chain_def::ChainDef;
use super::chain::chain_delivery_outcome::DeliveryOutcome;
use super::chain::chain_observed::Observed;
use super::chain::chain_rung::Rung;
use super::chain::execute_chain;
use super::context::Target;
use super::process_check::judge_owner;
use crate::system::x11::map::{ClientMatch, match_client};
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, FrameFacts, X11State, menu_export};
use crate::system::{ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, owner_process_id, within};
use crate::tree::capabilities::action_read::NodeView;
use crate::tree::vocabulary::role_numbers::is_menu_item;
use crate::tree::{AtspiElement, ReadPurpose, call, read_node_for};

fn refuse(message: &str) -> AdapterError {
    super::click::refusal(
        ErrorCode::ActionFailed,
        message,
        json!({ "native_menu": "unresolved" }),
    )
}

fn read_error(error: zbus::Error) -> AdapterError {
    refuse("The exported menu action could not be read").with_platform_detail(error.to_string())
}

async fn name(
    connection: &zbus::Connection,
    element: &AtspiElement,
) -> Result<String, AdapterError> {
    let reply = call(
        connection,
        element,
        PROPERTIES_INTERFACE,
        "Get",
        &(ACCESSIBLE_INTERFACE, "Name"),
    )
    .await
    .map_err(read_error)?;
    let value: OwnedValue = reply.body().deserialize().map_err(read_error)?;
    let text =
        <&str>::try_from(&value).map_err(|_| refuse("A menu ancestor's name could not be read"))?;
    Ok(text.to_owned())
}

pub(super) fn try_click(
    target: &Target<'_>,
    view: &NodeView,
) -> Result<Option<ActionResult>, AdapterError> {
    if !view.role().is_some_and(is_menu_item) {
        return Ok(None);
    }
    let frame = target
        .element
        .menu_owner()
        .or_else(|| target.element.frame().cloned());
    let Some(frame) = frame else { return Ok(None) };
    let accessibility = target.bus.get(target.deadline)?;
    let deadline = target.deadline;
    let (node, state) = std::thread::scope(|scope| {
        let display = scope.spawn(|| DisplayReader.clients_within(deadline));
        let node = within(target.deadline, async {
            read_node_for(accessibility.inner(), &frame, ReadPurpose::Frame).await
        });
        (node, display.join())
    });
    let (node, _) = node?;
    let Ok(X11State::Ready { clients, .. }) = state else {
        return Ok(None);
    };
    let facts = FrameFacts {
        pid: frame.pid(),
        title: node.properties.name.present().cloned().unwrap_or_default(),
        extents: node.extents.present().copied(),
        global_position: false,
        size_identity: false,
    };
    let ClientMatch::One(client) = match_client(&facts, &clients) else {
        return Ok(None);
    };
    let Some(export) = menu_export::read(client, target.element.pid(), target.deadline) else {
        return Ok(None);
    };
    let session = within(target.deadline, async {
        zbus::Connection::session().await.map_err(read_error)
    })?;
    within(target.deadline, async {
        judge_owner(
            target.element.pid(),
            owner_process_id(&session, &export.bus_name)
                .await
                .map_err(Some),
        )
    })?;
    let labels = within(target.deadline, async {
        join_all(
            target
                .element
                .ancestry()
                .menu_ancestors()
                .iter()
                .map(|ancestor| name(accessibility.inner(), ancestor)),
        )
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut labels = labels;
    if labels.iter().any(String::is_empty) {
        return Ok(None);
    }
    let Some(label) = view.name().filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    labels.push(label.to_owned());
    let Some(resolved) = within(target.deadline, async {
        native_menu_model::resolve(&session, &export.bus_name, &export.menubar_path, &labels)
            .await
            .map_err(read_error)
    })?
    else {
        return Ok(None);
    };
    let (action, path) = if let Some(action) = resolved.name.strip_prefix("win.") {
        (action, export.window_path.as_str())
    } else if let Some(action) = resolved.name.strip_prefix("app.") {
        (action, export.application_path.as_str())
    } else {
        return Ok(None);
    };
    let proxy = within(target.deadline, async {
        zbus::Proxy::new(&session, export.bus_name.as_str(), path, "org.gtk.Actions")
            .await
            .map_err(read_error)
    })?;
    let ((enabled, parameter, _),): ((bool, Signature, Vec<OwnedValue>),) =
        within(target.deadline, async {
            proxy.call("Describe", &(action,)).await.map_err(read_error)
        })?;
    let signature_matches = match resolved.target.as_ref() {
        Some(value) => value.value_signature() == &parameter,
        None => parameter.to_string().is_empty(),
    };
    if !enabled || !signature_matches || action.is_empty() {
        return Err(refuse(
            "The exported menu action is disabled or its parameter does not match",
        ));
    }
    let current_name = within(target.deadline, name(accessibility.inner(), target.element))?;
    if current_name != label {
        return Err(refuse("The menu target's name changed before activation"));
    }
    let parameters: Vec<OwnedValue> = resolved.target.into_iter().collect();
    let platform = HashMap::<String, OwnedValue>::new();
    let def = ChainDef {
        action: "click",
        suggestion: "Refresh the snapshot to inspect the action's result before retrying.",
    };
    let mut rungs = [Rung {
        label: "org.gtk.Actions.Activate",
        run: Box::new(|| {
            within(target.deadline, async {
                proxy
                    .call_with_flags::<_, _, ()>(
                        "Activate",
                        MethodFlags::NoReplyExpected | MethodFlags::NoAutoStart,
                        &(action, &parameters, &platform),
                    )
                    .await
                    .map_err(read_error)?;
                Ok(DeliveryOutcome::Delivered(Observed::Unread))
            })
            .map_err(|error| error.with_disposition(DeliverySemantics::delivered_unverified()))
        }),
    }];
    execute_chain(&def, &mut rungs, target.deadline).map(Some)
}

pub(crate) mod native_menu_action;
pub(crate) mod native_menu_model;
pub(crate) mod native_menu_search;
