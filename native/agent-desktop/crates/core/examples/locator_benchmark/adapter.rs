use crate::{
    fixture::Fixture,
    fixture_builder::{live_target_tree, live_tree},
};
use agent_desktop_core::{
    ActionOps, AdapterError, Deadline, ElementIdentifier, ErrorCode, IdentifierKind, InputOps,
    NativeHandle, ObservationOps, ObservationRequest, ObservationRoot, ObservationSource,
    ObservedTree, RefEntry, SystemOps, WindowFilter, WindowInfo,
};

pub(crate) struct FixtureAdapter<'a> {
    pub fixture: &'a Fixture,
}

impl ActionOps for FixtureAdapter<'_> {}
impl InputOps for FixtureAdapter<'_> {}
impl SystemOps for FixtureAdapter<'_> {}

impl ObservationOps for FixtureAdapter<'_> {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![self.fixture.window.clone()])
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match &root {
            ObservationRoot::Window(_) => {
                live_tree(self.fixture, request.evidence_for_raw_depth(0))
            }
            ObservationRoot::Element { entry, .. } => {
                let index = fixture_index_for_path(self.fixture, entry.scope.path.as_slice())?;
                live_target_tree(
                    self.fixture,
                    index,
                    ObservationSource::from_root(&root, request.surface),
                    request,
                )
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if deadline.is_expired() {
            return Err(AdapterError::timeout(
                "benchmark locator anchor deadline expired",
            ));
        }
        verify_source(self.fixture, entry)?;
        let index = fixture_index_for_path(self.fixture, entry.scope.path.as_slice())?;
        let node = self
            .fixture
            .nodes
            .get(index as usize)
            .ok_or_else(|| stale_anchor("benchmark locator path is invalid"))?;
        if node.role != entry.identity.role {
            return Err(stale_anchor("benchmark locator role changed"));
        }
        let identity_matches = entry
            .identity
            .native_id
            .as_ref()
            .is_some_and(|identifier| identifier_matches(node, identifier));
        let bounds_match = entry.geometry.bounds_hash.is_some()
            && entry.geometry.bounds_hash == node.bounds.bounds_hash();
        if !identity_matches && !bounds_match {
            return Err(stale_anchor("benchmark locator anchor changed"));
        }
        Ok(NativeHandle::null())
    }
}

fn verify_source(fixture: &Fixture, entry: &RefEntry) -> Result<(), AdapterError> {
    let window = &fixture.window;
    let process_matches = entry.process.pid == window.pid
        && entry.process.process_instance == window.process_instance;
    let window_matches = entry.source.source_window_id.as_deref() == Some(window.id.as_str())
        && entry.source.source_app.as_deref() == Some(window.app.as_str());
    if process_matches && window_matches {
        Ok(())
    } else {
        Err(stale_anchor("benchmark locator source changed"))
    }
}

fn identifier_matches(
    node: &crate::fixture_node::FixtureNode,
    identifier: &ElementIdentifier,
) -> bool {
    let value = identifier.value.as_str();
    match identifier.kind {
        IdentifierKind::AxIdentifier => node.identifiers.0.as_deref() == Some(value),
        IdentifierKind::AxDomIdentifier => node.identifiers.1.as_deref() == Some(value),
        IdentifierKind::Unknown => {
            node.identifiers.0.as_deref() == Some(value)
                || node.identifiers.1.as_deref() == Some(value)
        }
        IdentifierKind::AutomationId
        | IdentifierKind::RuntimeId
        | IdentifierKind::AtspiObjectPath => false,
    }
}

fn stale_anchor(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::StaleRef, message)
}

fn fixture_index_for_path(fixture: &Fixture, path: &[usize]) -> Result<u32, AdapterError> {
    let mut index = *fixture
        .roots
        .first()
        .ok_or_else(|| AdapterError::internal("benchmark fixture has no root"))?;
    for child_order in path {
        let node = fixture
            .nodes
            .get(index as usize)
            .ok_or_else(|| AdapterError::internal("benchmark fixture path is invalid"))?;
        index = *node
            .children
            .get(*child_order)
            .ok_or_else(|| AdapterError::internal("benchmark fixture path is invalid"))?;
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    #[test]
    fn selected_find_hydrates_every_benchmark_frame() {
        for scenario in crate::scenarios::all() {
            for fixture in &scenario.frames {
                let result = crate::live::run_live_find(fixture, &scenario.query)
                    .expect("selected benchmark find");

                assert_eq!(
                    result.correctness.matches, scenario.expected_matches,
                    "{}",
                    scenario.name
                );
                assert!(
                    result.correctness.selected_refs_reresolvable,
                    "{}",
                    scenario.name
                );
            }
        }
    }

    #[test]
    fn selected_find_uses_the_exact_path_anchor() {
        let scenario = crate::scenarios::all()
            .into_iter()
            .find(|scenario| scenario.name == "duplicate_button_role_and_name")
            .expect("benchmark scenario");

        let result = crate::live::run_live_find(scenario.frame(0), &scenario.query)
            .expect("selected benchmark find");

        assert_eq!(result.correctness.matches, scenario.expected_matches);
        assert!(result.correctness.selected_refs_reresolvable);
        assert_eq!(result.ref_count, 50);
    }
}
