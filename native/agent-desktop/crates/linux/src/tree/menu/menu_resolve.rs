use agent_desktop_core::{
    AdapterError, Deadline, LocatorEvidence, NativeHandle, RefEntry, SnapshotSurface,
};
use serde_json::json;
use zbus::Connection;

use super::menu_context::MenuContext;
use super::observe_menu::rooted;
use crate::system::menu::menu_surface::popups_at;
use crate::system::{SharedBus, owner_process_id, process::process_facts, within};
use crate::tree::live_read::with_reader;
use crate::tree::observe::node_evidence::read_evidence;
use crate::tree::placement::popup_position::{PopupPosition, popup_position_via};
use crate::tree::properties::liveness::Liveness;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::resolve::path_descent::Levels;
use crate::tree::resolve::resolve_errors::{ambiguous, settle_gone, stopped_app};
use crate::tree::resolve::resolve_gate::stored_window;
use crate::tree::resolve::resolve_search::evaluate;
use crate::tree::resolve::searched::Searched;
use crate::tree::resolve::{Source, resolve};
use crate::tree::walk::level::Level;
use crate::tree::walk::walker::walk_tree;
use crate::tree::{AtspiElement, WalkLimits};

pub(crate) fn is_menu_entry(entry: &RefEntry) -> bool {
    entry.source.source_surface == SnapshotSurface::Menu
}

fn unanswered() -> AdapterError {
    AdapterError::timeout("The accessible object did not answer in time")
}

pub(crate) fn menu_closed() -> AdapterError {
    AdapterError::stale_ref_because("The menu the ref was taken in is no longer open")
    .with_suggestion("Reopen the menu through its opener, take a fresh menu snapshot, and use the new ref. Refreshing a closed menu cannot restore this ref.")
    .with_details(
        json!({
            "kind": "menu_closed",
            "complete": true,
            "retryable": false,
        }),
    )
}

struct MenuSource<'a> {
    bus: &'a SharedBus,
    connection: Connection,
    popup: AtspiElement,
    levels: Option<Levels>,
    deadline: Deadline,
}

impl Source for MenuSource<'_> {
    fn open_window(&mut self, _entry: &RefEntry) -> Result<AtspiElement, AdapterError> {
        let root = rooted(&self.popup);
        self.levels = Some(Levels::new(self.connection.clone(), &root, self.deadline));
        Ok(root)
    }

    fn level(&mut self, element: &AtspiElement) -> Result<Level<AtspiElement>, AdapterError> {
        match self.levels.as_mut() {
            Some(levels) => levels.read(element),
            None => Err(AdapterError::internal(
                "A level was read before the popup was opened",
            )),
        }
    }

    fn evidence(&mut self, element: &AtspiElement) -> Result<LocatorEvidence, AdapterError> {
        let connection = &self.connection;
        let mut read = within(
            self.deadline,
            read_evidence(
                connection,
                element,
                crate::tree::properties::read_purpose::ReadPurpose::Identity,
            ),
        )?;
        read.evidence.identifiers = read
            .evidence
            .identifiers
            .with_retained_object(element.object_identity());
        match read.liveness {
            Liveness::TimedOut => Err(unanswered()),
            _ => Ok(read.evidence),
        }
    }

    fn search(&mut self, frame: &AtspiElement, entry: &RefEntry) -> Result<Searched, AdapterError> {
        let walk = walk_tree(self.bus, frame, &WalkLimits::default(), self.deadline)?;
        Ok(evaluate(&walk, entry, false))
    }

    fn stopped_app(&mut self, pid: u32) -> Option<String> {
        stopped_app(pid)
    }
}

fn context_changed(complete: bool) -> AdapterError {
    AdapterError::stale_ref_because("The open menu no longer proves the captured context")
        .with_suggestion("Keep the menu open, take a fresh menu snapshot, and use the new ref")
        .with_details(json!({
            "kind": if complete { "menu_context_changed" } else { "menu_context_unknown" },
            "complete": complete,
            "retryable": !complete,
        }))
}

/// Resolves a ref taken in a menu: the popup is found again from the window
/// the ref names, because a popup of GTK 3 and of Chromium is a new object on
/// every open, and the stored path descends from that popup. A ref that no
/// open popup answers to is stale, a closed menu most often; one that two
/// open popups answer to is ambiguous.
pub(crate) fn resolve_menu(
    bus: &SharedBus,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    let window = stored_window(entry)?;
    window.check_process(&process_facts::lookup(window.pid()), entry)?;
    let connection = bus.get(deadline)?.inner().clone();
    within(deadline, async {
        let owner = owner_process_id(&connection, window.bus()).await;
        window.check_owner(owner, entry)
    })?;
    let popups = popups_at(bus, &window.frame(), deadline)
        .map_err(|error| settle_gone(error, window.pid()))?;
    let mut candidates = Vec::new();
    for popup in popups {
        candidates.push((popup.context, popup.root));
    }
    resolve_contextual(entry, window.frame(), candidates, |popup, scoped_entry| {
        let mut source = MenuSource {
            bus,
            connection: connection.clone(),
            popup,
            levels: None,
            deadline,
        };
        resolve(&mut source, scoped_entry, deadline)
    })
    .and_then(|element| open_handle(element, |element| position_of(bus, element, deadline)))
}

fn position_of(
    bus: &SharedBus,
    element: &AtspiElement,
    deadline: Deadline,
) -> Result<PopupPosition, AdapterError> {
    let handle = element.clone().into_native_handle();
    with_reader(
        bus,
        &handle,
        deadline,
        ReadPurpose::Bounds,
        |reader, handle| popup_position_via(reader, handle, deadline),
    )
}

/// An item that was found in a popup the session places by its own window,
/// and that no window places any more, belongs to a popup that has closed
/// since the tree was read. A read of the item after an action that closed
/// its popup is not held to this: only resolution is.
fn open_handle(
    element: AtspiElement,
    position: impl FnOnce(&AtspiElement) -> Result<PopupPosition, AdapterError>,
) -> Result<NativeHandle, AdapterError> {
    match position(&element)? {
        PopupPosition::Placed | PopupPosition::Unplaceable => Ok(element.into_native_handle()),
        PopupPosition::Unmapped => Err(menu_closed()),
    }
}

fn resolve_contextual(
    entry: &RefEntry,
    owner: AtspiElement,
    candidates: Vec<(MenuContext, AtspiElement)>,
    mut resolve: impl FnMut(AtspiElement, &RefEntry) -> Result<AtspiElement, AdapterError>,
) -> Result<AtspiElement, AdapterError> {
    if candidates.is_empty() {
        return Err(menu_closed());
    }
    let mut landed = Vec::new();
    let mut refusal: Option<AdapterError> = None;
    for (context, popup) in candidates {
        let Some(scoped_entry) = context.entry_for(entry) else {
            let captured = entry
                .identity
                .retained_object
                .as_deref()
                .and_then(MenuContext::decode);
            let complete = context.is_complete()
                && captured.is_some_and(|(captured, _)| captured.is_complete());
            let error = context_changed(complete);
            if !complete || refusal.is_none() {
                refusal = Some(error);
            }
            continue;
        };
        match resolve(popup, &scoped_entry) {
            Ok(mut element) => {
                element.set_menu_owner(&owner);
                landed.push(element);
            }
            Err(error) => refusal = refusal.or(Some(error)),
        }
    }
    choose(landed, refusal)
}

fn choose(
    mut landed: Vec<AtspiElement>,
    refusal: Option<AdapterError>,
) -> Result<AtspiElement, AdapterError> {
    match (landed.len(), refusal) {
        (1, _) => landed.pop().ok_or_else(|| context_changed(true)),
        (0, Some(error)) => Err(error),
        (0, None) => Err(context_changed(true)),
        (count, _) => Err(ambiguous(count)),
    }
}

#[cfg(test)]
#[path = "menu_resolve_tests.rs"]
mod tests;
