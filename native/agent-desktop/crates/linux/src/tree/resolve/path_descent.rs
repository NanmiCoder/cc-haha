use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use zbus::Connection;

use super::landing::Landing;
use crate::system::within;
use crate::tree::properties::node_read::read_node_for;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::properties::toolkit_trust::read_web_family;
use crate::tree::walk::level::Level;
use crate::tree::walk::walker_expand::{UNKNOWN_PID, child_elements, learn_pids};
use crate::tree::{AtspiElement, RawNode};

const UNIDENTIFIED: &str = "The owning process of the bus name could not be identified";

/// Follows a stored child-index path from `root`, one full node read per
/// level. The path indexes the child list the walk stored it from, so the
/// closure must return children in that order. A level that cannot be read,
/// or a childless node of a web engine (whose tree fills in only after a
/// read other than `GetChildren`, L17-17), leaves the region unread. An
/// application that left the bus and an expired deadline end the descent with
/// their own error for the caller to map.
pub(crate) fn descend<K>(
    root: K,
    path: &[usize],
    deadline: Deadline,
    mut read: impl FnMut(&K) -> Result<Level<K>, AdapterError>,
) -> Result<Landing<K>, AdapterError> {
    let mut current = root;
    for &index in path {
        if deadline.is_expired() {
            return Err(deadline.timeout_error());
        }
        let level = match read(&current) {
            Ok(level) => level,
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::AppNotFound | ErrorCode::Timeout | ErrorCode::StaleRef
                ) =>
            {
                return Err(error);
            }
            Err(_) => return Ok(Landing::unread()),
        };
        if level.children_unread || (level.children.is_empty() && level.empty_means_unread) {
            return Ok(Landing::unread());
        }
        match level.children.into_iter().nth(index) {
            Some(next) => current = next,
            None => return Ok(Landing::nowhere()),
        }
    }
    Ok(Landing {
        element: Some(current),
        unread: false,
    })
}

/// The level a node read gives: the children the walk would record for it,
/// each carrying the ancestry the walk gives it.
pub(crate) fn level_of(
    node: &RawNode,
    pids: &HashMap<String, u32>,
    web_process: bool,
) -> Level<AtspiElement> {
    Level {
        children: child_elements(node, pids),
        children_unread: node.children.is_failed(),
        empty_means_unread: web_process,
    }
}

/// Reads levels on the shared accessibility connection with the walk's own
/// node read, learning the owner process of each bus name once.
pub(crate) struct Levels {
    connection: Connection,
    pids: HashMap<String, u32>,
    web: HashMap<String, bool>,
    deadline: Deadline,
}

impl Levels {
    pub(crate) fn new(connection: Connection, frame: &AtspiElement, deadline: Deadline) -> Self {
        Self {
            connection,
            pids: HashMap::from([(frame.bus_name().to_owned(), frame.pid())]),
            web: HashMap::new(),
            deadline,
        }
    }

    pub(crate) fn read(
        &mut self,
        element: &AtspiElement,
    ) -> Result<Level<AtspiElement>, AdapterError> {
        if element.pid() == UNKNOWN_PID {
            return Err(AdapterError::new(ErrorCode::ElementNotFound, UNIDENTIFIED));
        }
        let web_process = match self.web.get(element.bus_name()) {
            Some(web) => *web,
            None => {
                let web =
                    within(self.deadline, read_web_family(&self.connection, element))?.is_some();
                self.web.insert(element.bus_name().to_owned(), web);
                web
            }
        };
        let (connection, pids) = (&self.connection, &mut self.pids);
        within(self.deadline, async {
            let (node, _) = read_node_for(connection, element, ReadPurpose::Shape).await?;
            learn_pids(connection, pids, std::iter::once(&node)).await?;
            Ok(level_of(&node, pids, web_process))
        })
    }
}

#[cfg(test)]
#[path = "path_descent_tests.rs"]
mod tests;
