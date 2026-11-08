use agent_desktop_core::{AdapterError, Deadline};
use futures_util::stream::{self, StreamExt};
use zbus::Connection;

use super::scroll_find_bar::{Orientation, Site};
use crate::system::{ACCESSIBLE_INTERFACE, SharedBus, within};
use crate::tree::vocabulary::role_numbers::SCROLL_BAR;
use crate::tree::vocabulary::state_bits::{HORIZONTAL, StateBits, VERTICAL};
use crate::tree::{AtspiElement, list_children};

const MAX_NODES: usize = 2_000;
const IN_FLIGHT: usize = 48;

/// The nodes of one window met breadth first, each remembering what it hangs
/// from, and which of them is the target.
pub(crate) struct Crawl {
    pub(crate) nodes: Vec<(AtspiElement, Option<usize>, u32)>,
    pub(crate) target: Option<usize>,
}

fn same(element: &AtspiElement, bus: &str, path: &str) -> bool {
    element.bus_name() == bus && element.path() == path
}

pub(crate) async fn role_of(connection: &Connection, element: &AtspiElement) -> u32 {
    let reply = connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(ACCESSIBLE_INTERFACE),
            "GetRole",
            &(),
        )
        .await;
    reply
        .ok()
        .and_then(|message| message.body().deserialize::<u32>().ok())
        .unwrap_or(0)
}

pub(crate) async fn orientation_of(connection: &Connection, bar: &AtspiElement) -> Orientation {
    let reply = connection
        .call_method(
            Some(bar.bus_name()),
            bar.path(),
            Some(ACCESSIBLE_INTERFACE),
            "GetState",
            &(),
        )
        .await;
    let words = reply
        .ok()
        .and_then(|message| message.body().deserialize::<Vec<u32>>().ok())
        .unwrap_or_default();
    let states = StateBits::new(&words);
    if states.has(VERTICAL) {
        Orientation::Vertical
    } else if states.has(HORIZONTAL) {
        Orientation::Horizontal
    } else {
        Orientation::Unknown
    }
}

async fn crawl_window(
    connection: &Connection,
    root: &AtspiElement,
    target: &AtspiElement,
) -> Crawl {
    let mut crawl = Crawl {
        nodes: vec![(root.address(), None, 0)],
        target: same(target, root.bus_name(), root.path()).then_some(0),
    };
    let mut frontier = vec![0usize];
    while !frontier.is_empty() && crawl.nodes.len() < MAX_NODES {
        let listings: Vec<_> = stream::iter(frontier.iter().map(|&index| {
            let address = crawl.nodes[index].0.clone();
            async move {
                list_children(connection, &address)
                    .await
                    .unwrap_or_default()
            }
        }))
        .buffered(IN_FLIGHT)
        .collect()
        .await;
        let mut fresh: Vec<(usize, AtspiElement)> = frontier
            .iter()
            .zip(listings)
            .flat_map(|(&parent, children)| {
                children
                    .into_iter()
                    .map(move |(bus, path)| (parent, AtspiElement::new(bus, path, root.pid())))
            })
            .collect();
        fresh.truncate(MAX_NODES - crawl.nodes.len());
        let roles: Vec<u32> =
            stream::iter(fresh.iter().map(|(_, child)| role_of(connection, child)))
                .buffered(IN_FLIGHT)
                .collect()
                .await;
        frontier = Vec::with_capacity(fresh.len());
        for ((parent, child), role) in fresh.into_iter().zip(roles) {
            let index = crawl.nodes.len();
            if same(target, child.bus_name(), child.path()) {
                crawl.target = Some(index);
            }
            crawl.nodes.push((child, Some(parent), role));
            frontier.push(index);
        }
    }
    crawl
}

impl Crawl {
    pub(crate) fn of(
        bus: &SharedBus,
        root: &AtspiElement,
        target: &AtspiElement,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        let connection = bus.get(deadline)?;
        within(deadline, async {
            Ok(crawl_window(connection.inner(), root, target).await)
        })
    }

    /// Every node as a site, the scroll bars with the way they run.
    pub(crate) fn sites(
        &self,
        bus: &SharedBus,
        deadline: Deadline,
    ) -> Result<Vec<Site>, AdapterError> {
        let connection = bus.get(deadline)?;
        within(deadline, async {
            let bars: Vec<Orientation> =
                stream::iter(self.nodes.iter().map(|(address, _, role)| {
                    let connection = connection.inner();
                    async move {
                        if *role == SCROLL_BAR {
                            Some(orientation_of(connection, address).await)
                        } else {
                            None
                        }
                    }
                }))
                .buffered(IN_FLIGHT)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .map(|way| way.unwrap_or(Orientation::Unknown))
                .collect();
            Ok(self
                .nodes
                .iter()
                .zip(bars)
                .map(|((_, parent, role), way)| Site {
                    parent: *parent,
                    bar: (*role == SCROLL_BAR).then_some(way),
                })
                .collect())
        })
    }
}
