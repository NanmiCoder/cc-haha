use agent_desktop_core::{LocatorEvidence, ObservedSubtree};

use super::menu_context::MenuContext;
use crate::tree::ObservedRead;
use crate::tree::observe::decorate::Decorate;

pub(crate) struct MenuIdentity {
    context: MenuContext,
}

impl MenuIdentity {
    pub(crate) fn new(context: MenuContext) -> Self {
        Self { context }
    }
}

impl Decorate for MenuIdentity {
    fn decorate(
        &mut self,
        read: &ObservedRead,
        evidence: &mut LocatorEvidence,
        _first_child_index: usize,
    ) -> Vec<ObservedSubtree> {
        evidence.identifiers = evidence
            .identifiers
            .clone()
            .with_retained_object(self.context.encode(&read.node.element.object_identity()));
        Vec::new()
    }
}
