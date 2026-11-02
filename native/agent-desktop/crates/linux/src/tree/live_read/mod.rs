use crate::tree::placement::visibility::{placed_states, settled_by_read};
use agent_desktop_core::{
    AdapterError, Deadline, ElementState, ErrorCode, LiveElement, NativeHandle, Rect,
};
use zbus::Connection;

use super::live_read::live_offscreen::{global_position, placement};
use super::live_read::live_project::{
    live_actions, live_bounds, live_element, live_state, live_value, pointer_rect,
};
use super::menu::menu_context::MenuContext;
use super::observe::node_evidence::{NodeEvidence, read_evidence};
use super::placement::Placement;
use super::properties::liveness::Liveness;
use super::properties::read_purpose::ReadPurpose;
use super::resolve::resolve_errors::{
    object_gone, owner_unreachable, settle_gone, stopped_app, stopped_aware, window_tied,
};
use super::{AtspiElement, atspi_element};
use crate::system::{SharedBus, within};

/// What one live read needs from the bus. The bus implements it; a test
/// substitutes in-memory nodes and counts the reads.
pub(crate) trait NodeReader {
    fn read(&mut self, element: &AtspiElement) -> Result<NodeEvidence, AdapterError>;
    fn native_tree(
        &mut self,
        _element: &AtspiElement,
        _deadline: Deadline,
    ) -> Result<super::Walk<super::ObservedRead>, AdapterError> {
        Err(AdapterError::not_supported("modal tree observation"))
    }
    fn is_verified_shell(&mut self, _element: &AtspiElement, _deadline: Deadline) -> bool {
        false
    }
    fn top_levels(
        &mut self,
        _element: &AtspiElement,
        _deadline: Deadline,
    ) -> Result<Vec<AtspiElement>, AdapterError> {
        Err(AdapterError::not_supported("modal window observation"))
    }
    fn parent_lacks(&mut self, _element: &AtspiElement) -> bool {
        false
    }
    fn stopped_app(&mut self, pid: u32) -> Option<String>;
    /// Where the node sits in its window, read once.
    fn placement(&mut self, element: &AtspiElement, deadline: Deadline) -> Placement;
    /// Whether the node's toolkit reports global screen positions.
    fn global_position(&mut self, element: &AtspiElement, deadline: Deadline) -> bool;
    /// The freshly observed context of the popup owning a resolved menu
    /// target, including incomplete evidence that must fail identity matching.
    fn menu_context(
        &mut self,
        _element: &AtspiElement,
        _deadline: Deadline,
    ) -> Result<Option<MenuContext>, AdapterError> {
        Ok(None)
    }
}

pub(super) struct BusReader<'a> {
    bus: &'a SharedBus,
    connection: &'a Connection,
    deadline: Deadline,
    purpose: ReadPurpose,
}

impl NodeReader for BusReader<'_> {
    fn read(&mut self, element: &AtspiElement) -> Result<NodeEvidence, AdapterError> {
        within(
            self.deadline,
            read_evidence(self.connection, element, self.purpose),
        )
    }

    fn native_tree(
        &mut self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<super::Walk<super::ObservedRead>, AdapterError> {
        super::walk::walker::walk_native_tree(self.bus, element, deadline)
    }

    fn is_verified_shell(&mut self, element: &AtspiElement, deadline: Deadline) -> bool {
        crate::system::shell::is_shell_element(element)
            && crate::system::shell::identity::find_root(self.bus, deadline)
                .is_ok_and(|root| root.bus_name == element.bus_name())
    }

    fn top_levels(
        &mut self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Vec<AtspiElement>, AdapterError> {
        let root = AtspiElement::new(
            element.bus_name(),
            crate::system::REGISTRY_ROOT_PATH,
            element.pid(),
        );
        within(deadline, async {
            let children = super::list_children(self.connection, &root).await?;
            let mut windows = Vec::with_capacity(children.len());
            for (bus, path) in children {
                let pid = if bus == element.bus_name() {
                    element.pid()
                } else {
                    crate::system::process_id(self.connection, bus.clone())
                        .await
                        .1?
                };
                windows.push(AtspiElement::new(bus, path, pid));
            }
            Ok(windows)
        })
    }

    fn parent_lacks(&mut self, element: &AtspiElement) -> bool {
        super::properties::absence::parent_lacks(self.connection, element, self.deadline)
    }

    fn stopped_app(&mut self, pid: u32) -> Option<String> {
        stopped_app(pid)
    }

    fn placement(&mut self, element: &AtspiElement, deadline: Deadline) -> Placement {
        placement(self.bus, element, deadline)
    }

    fn global_position(&mut self, element: &AtspiElement, deadline: Deadline) -> bool {
        global_position(self.bus, element, deadline)
    }

    fn menu_context(
        &mut self,
        element: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Option<MenuContext>, AdapterError> {
        super::menu::menu_context::for_element(self.bus, element, deadline)
    }
}

/// Reads the node a handle names once and maps what the read shows. An
/// application that left and a destroyed object are a settled `STALE_REF`; a
/// node that did not answer is a timeout, `APP_UNRESPONSIVE` when `/proc`
/// shows its process stopped.
pub(crate) fn read_live<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
) -> Result<NodeEvidence, AdapterError> {
    let element = atspi_element(handle)?;
    let pid = element.frame().map_or_else(|| element.pid(), |f| f.pid());
    let outcome = reader.read(element).and_then(|node| match node.liveness {
        Liveness::Alive
            if node
                .read
                .node
                .traits
                .states
                .present()
                .is_some_and(|words| words.iter().all(|word| *word == 0))
                && reader.parent_lacks(element) =>
        {
            Err(object_gone())
        }
        Liveness::Alive => Ok(node),
        Liveness::TimedOut => Err(AdapterError::timeout(
            "The accessible object did not answer in time",
        )),
        Liveness::ObjectGone => Err(object_gone()),
        Liveness::AppGone => Err(owner_unreachable(pid)),
    });
    outcome.map_err(|error| {
        let error = settle_gone(error, pid);
        if error.code == ErrorCode::Timeout {
            let stopped = reader.stopped_app(pid);
            stopped_aware(error, stopped.as_deref())
        } else {
            error
        }
    })
}

pub(super) fn with_reader<T>(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
    purpose: ReadPurpose,
    project: impl FnOnce(&mut BusReader<'_>, &NativeHandle) -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    atspi_element(handle)?;
    let connection = bus.get(deadline)?.inner().clone();
    let mut reader = BusReader {
        bus,
        connection: &connection,
        deadline,
        purpose,
    };
    project(&mut reader, handle)
}

pub(crate) fn state_via<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<ElementState>, AdapterError> {
    let node = read_live(reader, handle)?;
    let placed = if settled_by_read(&node.read) {
        Placement::default()
    } else {
        reader.placement(atspi_element(handle)?, deadline)
    };
    live_state(&node.read, &node.evidence, &placed).map(Some)
}

/// The one placement a live element needs, read only when the state or the
/// bounds want it: the state wants it unless the node read already settles
/// offscreen, the bounds want it unless the toolkit's extents are global.
pub(crate) fn element_via<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<LiveElement, AdapterError> {
    let node = read_live(reader, handle)?;
    let element = atspi_element(handle)?;
    super::surfaces::modal_gate::ensure_unblocked(reader, element, deadline)?;
    let global = reader.global_position(element, deadline);
    let placed = if global && settled_by_read(&node.read) {
        Placement::default()
    } else {
        reader.placement(element, deadline)
    };
    let mut live = live_element(&node.read, &node.evidence, &placed, global)?;
    if element.is_menu_target() {
        let context = reader.menu_context(element, deadline)?;
        let object = context.map_or_else(
            || element.object_identity(),
            |context| context.encode(&element.object_identity()),
        );
        live.identity.identifiers = live.identity.identifiers.with_retained_object(object);
    }
    Ok(live)
}

pub(crate) fn bounds_via<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    let node = read_live(reader, handle)?;
    let element = atspi_element(handle)?;
    if reader.global_position(element, deadline) {
        return Ok(live_bounds(&node.read));
    }
    let placed = reader.placement(element, deadline);
    Ok(pointer_rect(&node.read, &placed))
}

pub(crate) fn pointer_via<R: NodeReader>(
    reader: &mut R,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<agent_desktop_core::PointerObservation, AdapterError> {
    let node = read_live(reader, handle)?;
    let element = atspi_element(handle)?;
    let global = reader.global_position(element, deadline);
    let placed = if global && settled_by_read(&node.read) {
        Placement::default()
    } else {
        reader.placement(element, deadline)
    };
    let bounds = if global {
        live_bounds(&node.read)
    } else {
        pointer_rect(&node.read, &placed)
    };
    if bounds.is_none() && placed.tie.is_some() {
        return Err(window_tied());
    }
    let states = placed_states(&node.read, &node.evidence, &placed)?.states;
    Ok(agent_desktop_core::PointerObservation { bounds, states })
}

pub(crate) fn observe_pointer(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<agent_desktop_core::PointerObservation, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Bounds,
        |reader, handle| pointer_via(reader, handle, deadline),
    )
}

pub(crate) fn get_live_value(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Value,
        |reader, handle| live_value(&read_live(reader, handle)?.evidence),
    )
}

pub(crate) fn get_live_state(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<ElementState>, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::State,
        |reader, handle| state_via(reader, handle, deadline),
    )
}

pub(crate) fn get_live_actions(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<Vec<String>>, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Actions,
        |reader, handle| live_actions(&read_live(reader, handle)?.evidence).map(Some),
    )
}

pub(crate) fn get_live_element(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<LiveElement, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Element,
        |reader, handle| element_via(reader, handle, deadline),
    )
}

pub(crate) fn get_element_bounds(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Bounds,
        |reader, handle| bounds_via(reader, handle, deadline),
    )
}

pub(crate) mod live_offscreen;
pub(crate) mod live_project;
pub(crate) mod pointer_refusal;
#[cfg(test)]
#[path = "live_read_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "live_menu_tests.rs"]
mod menu_tests;

#[cfg(test)]
#[path = "live_popup_bounds_tests.rs"]
mod popup_bounds_tests;

#[cfg(test)]
#[path = "live_modal_tests.rs"]
mod modal_tests;
