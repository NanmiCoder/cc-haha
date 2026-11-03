use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NativeHandle, tree::state};
use futures_util::future::join3;
use zbus::Connection;
use zbus::zvariant::{OwnedValue, Value};

use super::scroll_crawl::{Crawl, orientation_of, role_of};
use super::scroll_find_bar::{Orientation, Site, choose_bar};
use super::scroll_into_view::{BarFound, Geometry, ScrollPort, View};
use super::scroll_plan::{Axis, BarRange};
use crate::actions::context::Target;
use crate::actions::write::mutation::{WriteKind, WriteReply};
use crate::actions::write::write_call::{Call, invoke};
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::window::window_filter::frame_state;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, X11Client, X11State};
use crate::system::{PROPERTIES_INTERFACE, SharedBus, within};
use crate::tree::live_read::live_offscreen::toolkit_of;
use crate::tree::surfaces::window_extents::read_window_extents;
use crate::tree::vocabulary::role_numbers::SCROLL_BAR;
use crate::tree::{
    AtspiElement, COMPONENT_INTERFACE, Extents, get_element_bounds, get_live_state, list_children,
    read_node,
};

const VALUE_INTERFACE: &str = "org.a11y.atspi.Value";
const TOP_LEFT: u32 = 0;

/// The accessibility-bus side of a scroll: reads the target, calls
/// `ScrollTo`, finds the scroll bar and writes its `Value`.
pub(crate) struct BusPort<'a> {
    bus: &'a SharedBus,
    handle: &'a NativeHandle,
    element: &'a AtspiElement,
    deadline: Deadline,
    bar: Option<AtspiElement>,
    crawl: Option<Crawl>,
}

impl<'a> BusPort<'a> {
    pub(crate) fn new(
        bus: &'a SharedBus,
        handle: &'a NativeHandle,
        element: &'a AtspiElement,
        deadline: Deadline,
    ) -> Self {
        Self {
            bus,
            handle,
            element,
            deadline,
            bar: None,
            crawl: None,
        }
    }

    pub(crate) fn bar(&self) -> Option<&AtspiElement> {
        self.bar.as_ref()
    }

    pub(crate) fn bar_orientation(&self) -> Result<Orientation, AdapterError> {
        let Some(bar) = self.bar.as_ref() else {
            return Ok(Orientation::Unknown);
        };
        let connection = self.connection()?;
        within(self.deadline, async {
            Ok(orientation_of(connection.inner(), bar).await)
        })
    }

    fn window_minimized(&self) -> bool {
        let Some(frame) = self.element.frame() else {
            return false;
        };
        let Ok(shared) = self.bus.get(self.deadline) else {
            return false;
        };
        let read = within(self.deadline, async {
            read_node(shared.inner(), frame).await
        });
        read.is_ok_and(|node| frame_state(&node.traits.states).minimized == Some(true))
            || self.every_window_hidden()
    }

    fn every_window_hidden(&self) -> bool {
        match DisplayReader.clients_within(self.deadline) {
            X11State::Ready { clients, .. } => every_window_hidden(&clients, self.element.pid()),
            _ => false,
        }
    }

    fn connection(&self) -> Result<zbus::blocking::Connection, AdapterError> {
        self.bus.get(self.deadline)
    }

    fn crawl(&mut self) -> Result<Option<&Crawl>, AdapterError> {
        if self.crawl.is_none() {
            let Some(frame) = self.element.frame() else {
                return Ok(None);
            };
            self.crawl = Some(Crawl::of(self.bus, frame, self.element, self.deadline)?);
        }
        Ok(self.crawl.as_ref())
    }

    fn neighbour(&mut self) -> Result<Option<(i64, Extents)>, AdapterError> {
        let (bus, deadline) = (self.bus, self.deadline);
        let Some(crawl) = self.crawl()? else {
            return Ok(None);
        };
        let Some(target) = crawl.target else {
            return Ok(None);
        };
        let Some(parent) = crawl.nodes[target].1 else {
            return Ok(None);
        };
        let siblings: Vec<usize> = crawl
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.1 == Some(parent))
            .map(|(index, _)| index)
            .collect();
        let place = siblings.iter().position(|&index| index == target);
        let Some(place) = place else {
            return Ok(None);
        };
        let mut order: Vec<usize> = (0..siblings.len()).filter(|&at| at != place).collect();
        order.sort_by_key(|&at| at.abs_diff(place));
        for at in order {
            if deadline.is_expired() {
                break;
            }
            let rect = read_window_extents(bus, &crawl.nodes[siblings[at]].0, deadline);
            if let Some(rect) = rect.filter(|rect| positive(*rect)) {
                return Ok(Some((place as i64 - at as i64, rect)));
            }
        }
        Ok(None)
    }

    fn bar_in_container(&self, axis: Axis) -> Result<Option<AtspiElement>, AdapterError> {
        let Some(container) = self.element.scroll_container() else {
            return Ok(None);
        };
        let connection = self.connection()?;
        let bars = within(self.deadline, async {
            let children = list_children(connection.inner(), container).await?;
            let mut found = Vec::new();
            for (bus, path) in children {
                let child = AtspiElement::new(bus, path, container.pid());
                if role_is_bar(connection.inner(), &child).await {
                    let way = orientation_of(connection.inner(), &child).await;
                    found.push((child, way));
                }
            }
            Ok(found)
        })?;
        if bars.iter().any(|(bar, _)| bar == self.element) {
            return Ok(None);
        }
        let mut sites = vec![
            Site {
                parent: None,
                bar: None,
            },
            Site {
                parent: Some(0),
                bar: None,
            },
        ];
        sites.extend(bars.iter().map(|(_, way)| Site {
            parent: Some(0),
            bar: Some(*way),
        }));
        Ok(choose_bar(&sites, Some(1), axis)?
            .and_then(|index| bars.into_iter().nth(index - 2))
            .map(|(bar, _)| bar))
    }
}

pub(crate) fn every_window_hidden(clients: &[X11Client], pid: u32) -> bool {
    let own: Vec<_> = clients
        .iter()
        .filter(|client| client.pid == Some(pid))
        .collect();
    !own.is_empty() && own.iter().all(|client| client.hidden)
}

fn positive(rect: Extents) -> bool {
    rect.width > 0 && rect.height > 0 && rect.x != i32::MIN && rect.y != i32::MIN
}

async fn role_is_bar(connection: &Connection, element: &AtspiElement) -> bool {
    role_of(connection, element).await == SCROLL_BAR
}

async fn number(connection: &Connection, bar: &AtspiElement, name: &str) -> Option<f64> {
    let reply = connection
        .call_method(
            Some(bar.bus_name()),
            bar.path(),
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(VALUE_INTERFACE, name),
        )
        .await
        .ok()?;
    let value = reply.body().deserialize::<OwnedValue>().ok()?;
    value
        .downcast_ref::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

impl ScrollPort for BusPort<'_> {
    fn toolkit(&mut self) -> ToolkitId {
        toolkit_of(self.bus, self.element, self.deadline)
    }

    fn view(&mut self) -> Result<View, AdapterError> {
        let Some(read) = get_live_state(self.bus, self.handle, self.deadline)? else {
            return Ok(View {
                offscreen: None,
                hidden: false,
                window_minimized: self.window_minimized(),
                bounds_provable: false,
            });
        };
        if read.offscreen == Some(true)
            && super::scroll_plan::viewport_clipped(
                &crate::tree::live_read::live_offscreen::placement(
                    self.bus,
                    self.element,
                    self.deadline,
                ),
            )
        {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "The scroll viewport is not contained on one display",
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
        }
        let bounds_provable = read.offscreen == Some(true)
            || get_element_bounds(self.bus, self.handle, self.deadline)?.is_some();
        Ok(View {
            offscreen: read.offscreen,
            hidden: read.states.iter().any(|token| token == state::HIDDEN),
            window_minimized: self.window_minimized(),
            bounds_provable,
        })
    }

    fn observe(&mut self) -> Result<Option<bool>, AdapterError> {
        match get_live_state(self.bus, self.handle, self.deadline) {
            Ok(read) => Ok(read.and_then(|read| read.offscreen)),
            Err(error) if error.code == ErrorCode::Timeout => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn scroll_to(&mut self) -> Result<bool, AdapterError> {
        let target = Target {
            bus: self.bus,
            handle: self.handle,
            element: self.element,
            deadline: self.deadline,
        };
        invoke(
            &target,
            Call {
                interface: COMPONENT_INTERFACE,
                method: "ScrollTo",
                body: &(TOP_LEFT,),
                kind: WriteKind::ScrollTo,
            },
        )
        .map(|reply| reply == WriteReply::Done)
    }

    fn geometry(&mut self) -> Result<Geometry, AdapterError> {
        let (bus, deadline) = (self.bus, self.deadline);
        let target = read_window_extents(bus, self.element, deadline);
        let positioned = target.is_some_and(positive);
        Ok(Geometry {
            target,
            container: self
                .element
                .scroll_container()
                .and_then(|container| read_window_extents(bus, container, deadline)),
            frame: self
                .element
                .frame()
                .and_then(|frame| read_window_extents(bus, frame, deadline)),
            neighbour: if positioned { None } else { self.neighbour()? },
        })
    }

    fn find_bar(&mut self, axis: Axis) -> Result<BarFound, AdapterError> {
        let has_container = self.element.scroll_container().is_some();
        let mut found = self.bar_in_container(axis)?;
        if found.is_none() {
            let (bus, deadline) = (self.bus, self.deadline);
            if let Some(crawl) = self.crawl()?.filter(|crawl| crawl.target.is_some()) {
                let sites = crawl.sites(bus, deadline)?;
                found = choose_bar(&sites, crawl.target, axis)?
                    .map(|index| crawl.nodes[index].0.clone());
            }
        }
        let Some(bar) = found else {
            return Ok(BarFound::Missing {
                container: has_container,
            });
        };
        let extents = read_window_extents(self.bus, &bar, self.deadline);
        self.bar = Some(bar);
        Ok(BarFound::Found { extents })
    }

    fn range(&mut self) -> Result<Option<BarRange>, AdapterError> {
        let Some(bar) = self.bar.as_ref() else {
            return Ok(None);
        };
        let connection = self.connection()?;
        let (min, max, current) = within(self.deadline, async {
            if !crate::tree::properties::interface_support::supports(
                connection.inner(),
                bar,
                VALUE_INTERFACE,
            )
            .await
            .unwrap_or(false)
            {
                return Ok((None, None, None));
            }
            Ok(join3(
                number(connection.inner(), bar, "MinimumValue"),
                number(connection.inner(), bar, "MaximumValue"),
                number(connection.inner(), bar, "CurrentValue"),
            )
            .await)
        })?;
        Ok(match (min, max, current) {
            (Some(min), Some(max), Some(current)) if max > min => {
                Some(BarRange { min, max, current })
            }
            _ => None,
        })
    }

    fn write(&mut self, value: f64) -> Result<(), AdapterError> {
        let Some(bar) = self.bar.as_ref() else {
            return Err(AdapterError::new(
                ErrorCode::Internal,
                "No scroll bar was found to write",
            ));
        };
        let handle = bar.clone().into_native_handle();
        let target = Target {
            bus: self.bus,
            handle: &handle,
            element: bar,
            deadline: self.deadline,
        };
        match invoke(
            &target,
            Call {
                interface: PROPERTIES_INTERFACE,
                method: "Set",
                body: &(VALUE_INTERFACE, "CurrentValue", Value::from(value)),
                kind: WriteKind::SetProperty,
            },
        )? {
            WriteReply::Done => Ok(()),
            WriteReply::Absent => Err(AdapterError::new(
                ErrorCode::ActionNotSupported,
                "The scroll bar does not accept value writes",
            )
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())),
        }
    }
}

#[cfg(test)]
#[path = "scroll_bus_tests.rs"]
mod tests;
