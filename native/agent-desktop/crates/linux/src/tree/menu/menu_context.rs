use std::hash::{Hash, Hasher};

use agent_desktop_core::{AdapterError, Deadline, RefEntry};

use crate::system::SharedBus;
use crate::tree::{AtspiElement, ObservedRead, WalkedNode};

const PREFIX: &str = "linux-menu:v1:";

pub(crate) fn for_element(
    bus: &SharedBus,
    element: &AtspiElement,
    deadline: Deadline,
) -> Result<Option<MenuContext>, AdapterError> {
    let (Some(frame), Some(owner)) = (element.frame(), element.menu_owner()) else {
        return Ok(None);
    };
    let popups = crate::system::menu::menu_surface::popups_at(bus, &owner, deadline)?;
    let mut candidates = popups.into_iter().filter(|popup| popup.root == *frame);
    let Some(popup) = candidates.next() else {
        return Ok(None);
    };
    Ok(candidates.next().is_none().then_some(popup.context))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MenuContext {
    root: String,
    shape: u64,
    complete: bool,
}

impl MenuContext {
    pub(crate) fn is_complete(&self) -> bool {
        self.complete
    }

    pub(crate) fn from_walk(root: &WalkedNode<ObservedRead>) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        hash_node(root, &mut hasher);
        Self {
            root: root.payload.node.element.object_identity(),
            shape: hasher.finish(),
            complete: tree_complete(root),
        }
    }

    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.complete && other.complete && self == other
    }

    pub(crate) fn entry_for(&self, entry: &RefEntry) -> Option<RefEntry> {
        let token = entry.identity.retained_object.as_deref()?;
        let (expected, object) = Self::decode(token)?;
        if !expected.matches(self) || object.is_empty() {
            return None;
        }
        let mut scoped = entry.clone();
        scoped.identity.retained_object = Some(object.to_owned());
        Some(scoped)
    }

    pub(crate) fn encode(&self, object: &str) -> String {
        format!(
            "{PREFIX}{}:{}:{}:{}:{}",
            self.shape,
            u8::from(self.complete),
            self.root.len(),
            self.root,
            object
        )
    }

    #[cfg(test)]
    pub(crate) fn test(root: &str, shape: u64) -> Self {
        Self {
            root: root.to_owned(),
            shape,
            complete: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_incomplete(root: &str, shape: u64) -> Self {
        Self {
            root: root.to_owned(),
            shape,
            complete: false,
        }
    }

    pub(crate) fn decode(token: &str) -> Option<(Self, &str)> {
        let rest = token.strip_prefix(PREFIX)?;
        let (shape, rest) = rest.split_once(':')?;
        let (complete, rest) = rest.split_once(':')?;
        let (root_len, rest) = rest.split_once(':')?;
        let shape = shape.parse().ok()?;
        let complete = match complete {
            "0" => false,
            "1" => true,
            _ => return None,
        };
        let root_len: usize = root_len.parse().ok()?;
        if rest.len() < root_len || !rest.is_char_boundary(root_len) {
            return None;
        }
        let root = rest[..root_len].to_owned();
        let rest = rest[root_len..].strip_prefix(':')?;
        let (root, object) = (root, rest);
        Some((
            Self {
                root,
                shape,
                complete,
            },
            object,
        ))
    }
}

fn tree_complete(node: &WalkedNode<ObservedRead>) -> bool {
    !node.truncated
        && !node.payload.node.traits.role.is_failed()
        && !node.payload.node.properties.name.is_failed()
        && node.payload.label != crate::tree::LabelOutcome::Failed
        && node.children.iter().all(tree_complete)
}

fn hash_node(node: &WalkedNode<ObservedRead>, hasher: &mut impl Hasher) {
    node.payload.node.element.object_identity().hash(hasher);
    node.payload.node.traits.role.present().hash(hasher);
    node.payload.node.properties.name.present().hash(hasher);
    node.payload.label.hash(hasher);
    node.truncated.hash(hasher);
    node.child_count.hash(hasher);
    node.children.len().hash(hasher);
    for child in &node.children {
        hash_node(child, hasher);
    }
}

#[cfg(test)]
#[path = "menu_context_tests.rs"]
mod tests;
